"""
nymrel_crawler_mesh.robots
RFC 9309 Compliant robots.txt Parser
Copyright (c) 2026 Nymrel / JalenBuilds LLC
"""

import re
from dataclasses import dataclass
from typing import Dict, List, Optional
from urllib.parse import urlparse


@dataclass
class RobotsRule:
    pattern: str
    regex: re.Pattern
    allow: bool
    specificity: int


@dataclass
class UserAgentRules:
    user_agent: str
    rules: List[RobotsRule]
    crawl_delay: Optional[float] = None


def pattern_to_regex(pattern: str) -> re.Pattern:
    escaped = re.escape(pattern)
    # Replace escaped \* with .*
    escaped = escaped.replace(r"\*", ".*")
    # Handle end anchor \$
    if escaped.endswith(r"\$"):
        escaped = escaped[:-2] + "$"
    elif not escaped.endswith("$"):
        escaped = "^" + ("" if escaped.startswith("/") else "/") + escaped
    else:
        escaped = "^" + ("" if escaped.startswith("/") else "/") + escaped
    return re.compile(escaped)


class RobotsParser:
    def __init__(self, content: Optional[str] = None):
        self.user_agent_groups: Dict[str, UserAgentRules] = {}
        self.sitemaps: List[str] = []
        if content:
            self.parse(content)

    def parse(self, content: str) -> None:
        self.user_agent_groups.clear()
        self.sitemaps.clear()

        lines = content.splitlines()
        current_user_agents: List[str] = []
        is_reading_user_agents = False

        for raw_line in lines:
            line = raw_line.split("#")[0].strip()
            if not line:
                continue

            if ":" not in line:
                continue

            field, value = line.split(":", 1)
            field = field.strip().lower()
            value = value.strip()

            if field == "user-agent":
                ua = value.lower()
                if not is_reading_user_agents:
                    current_user_agents = []
                    is_reading_user_agents = True
                if ua not in current_user_agents:
                    current_user_agents.append(ua)
                if ua not in self.user_agent_groups:
                    self.user_agent_groups[ua] = UserAgentRules(user_agent=ua, rules=[])
            elif field == "sitemap":
                is_reading_user_agents = False
                if value and value not in self.sitemaps:
                    self.sitemaps.append(value)
            elif field in ("disallow", "allow"):
                is_reading_user_agents = False
                if not current_user_agents:
                    current_user_agents = ["*"]
                    if "*" not in self.user_agent_groups:
                        self.user_agent_groups["*"] = UserAgentRules(user_agent="*", rules=[])

                is_allow = field == "allow"
                if value == "":
                    if not is_allow:
                        for ua in current_user_agents:
                            group = self.user_agent_groups.get(ua)
                            if group:
                                group.rules.append(
                                    RobotsRule(pattern="", regex=re.compile(r"^"), allow=True, specificity=0)
                                )
                    continue

                rule = RobotsRule(
                    pattern=value,
                    regex=pattern_to_regex(value),
                    allow=is_allow,
                    specificity=len(value),
                )

                for ua in current_user_agents:
                    group = self.user_agent_groups.get(ua)
                    if group:
                        group.rules.append(rule)
            elif field == "crawl-delay":
                try:
                    delay = float(value)
                    if delay >= 0:
                        for ua in current_user_agents:
                            group = self.user_agent_groups.get(ua)
                            if group:
                                group.crawl_delay = delay
                except ValueError:
                    pass

    def _find_matching_group(self, user_agent: str) -> Optional[UserAgentRules]:
        target_ua = user_agent.lower()
        if target_ua in self.user_agent_groups:
            return self.user_agent_groups[target_ua]

        for ua_key, group in self.user_agent_groups.items():
            if ua_key != "*" and ua_key in target_ua:
                return group

        return self.user_agent_groups.get("*")

    def is_allowed(self, url_str: str, user_agent: str = "*") -> bool:
        try:
            parsed = urlparse(url_str)
            pathname = parsed.path + ("?" + parsed.query if parsed.query else "")
            if not pathname:
                pathname = "/"
        except Exception:
            pathname = url_str if url_str.startswith("/") else "/" + url_str

        group = self._find_matching_group(user_agent)
        if not group or not group.rules:
            return True

        matched_rule: Optional[RobotsRule] = None
        for rule in group.rules:
            if rule.regex.search(pathname):
                if matched_rule is None:
                    matched_rule = rule
                elif rule.specificity > matched_rule.specificity:
                    matched_rule = rule
                elif rule.specificity == matched_rule.specificity:
                    if rule.allow:
                        matched_rule = rule

        if matched_rule is None:
            return True

        return matched_rule.allow

    def get_crawl_delay(self, user_agent: str = "*") -> Optional[float]:
        group = self._find_matching_group(user_agent)
        return group.crawl_delay if group else None

    def get_sitemaps(self) -> List[str]:
        return list(self.sitemaps)
