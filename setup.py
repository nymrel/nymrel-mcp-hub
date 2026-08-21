#!/usr/bin/env python3
"""
setup.py for nymrel-mcp-hub (dual-engine packaging)
"""
from setuptools import setup, find_packages

setup(
    name="nymrel-mcp-hub",
    version="1.0.0",
    description="Unified Model Context Protocol (MCP) server aggregating all 14 Nymrel open-source agent tools",
    long_description=open("README.md", encoding="utf-8").read() if open("README.md", encoding="utf-8") else "",
    long_description_content_type="text/markdown",
    author="Nymrel / JalenBuilds LLC",
    author_email="contact@jalenbuilds.com",
    url="https://github.com/nymrel/nymrel-mcp-hub",
    license="MIT",
    package_dir={"": "python"},
    packages=find_packages(where="python"),
    python_requires=">=3.10",
    install_requires=[],
    entry_points={
        "console_scripts": [
            "nymrel-mcp=nymrel_mcp_hub.cli:main",
        ],
    },
    classifiers=[
        "License :: OSI Approved :: MIT License",
        "Programming Language :: Python :: 3",
        "Operating System :: OS Independent",
    ],
)
