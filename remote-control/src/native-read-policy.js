import path from 'node:path';

// Path-based exclusions for routine credential material. This is deliberately
// not a detector for secrets embedded in otherwise ordinary documents.
const PRIVATE_COMPONENTS = new Set([
  '.git', '.ssh', '.aws', '.azure', '.gnupg', '.studio-secrets',
  '.npmrc', '.pypirc', '.netrc', '_netrc',
  'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519'
]);
const CREDENTIAL_FILE = /^(?:credentials?|secrets?)(?:\..*)?$|^(?:auth|device|tokens?|application_default_credentials|service[-_]account)\.json(?:\..*)?$|^client_secret.*\.json(?:\..*)?$/i;
const PRIVATE_EXTENSION = /\.(?:key|pem|p8|p12|pfx|jks|keystore|kdbx)(?:\..*)?$/i;

export class NativeReadPolicy {
  constructor({ cwd, deniedPaths = [], platform = process.platform } = {}) {
    if (!Array.isArray(deniedPaths) || deniedPaths.some((value) => typeof value !== 'string' || !value.trim())) {
      throw new Error('deniedReadPaths must be a string array of non-empty paths');
    }
    this.platform = platform;
    this.paths = platform === 'win32' ? path.win32 : path.posix;
    this.cwd = cwd || this.paths.resolve('.');
    this.deniedPaths = deniedPaths.map((value) => this.paths.resolve(this.cwd, value));
  }

  assertReadable(candidate) {
    if (typeof candidate !== 'string' || !candidate || candidate.includes('\0')) {
      throw new Error('path must be a non-empty string without NUL bytes');
    }
    if (this.platform === 'win32') {
      // Alternate data streams and device namespaces can alias an innocent
      // filename. Only the ordinary leading drive colon is accepted.
      const ordinary = candidate.replace(/^[a-z]:/i, '');
      if (ordinary.includes(':') || /^[\\/]{2}[?.][\\/]/.test(candidate)) this.#deny();
    }
    const components = candidate.split(this.platform === 'win32' ? /[\\/]/ : /\//);
    for (const raw of components) {
      const name = (this.platform === 'win32' ? raw.replace(/[. ]+$/, '') : raw).toLowerCase();
      if (PRIVATE_COMPONENTS.has(name) || name.startsWith('.env') || /(?:^|\.)env(?:$|\.)/.test(name)
          || CREDENTIAL_FILE.test(name) || PRIVATE_EXTENSION.test(name)) this.#deny();
    }
    const fold = (value) => this.platform === 'win32' ? value.toLowerCase() : value;
    const target = fold(this.paths.resolve(this.cwd, candidate));
    for (const denied of this.deniedPaths) {
      const relative = this.paths.relative(fold(denied), target);
      if (relative === '' || (!relative.startsWith('..') && !this.paths.isAbsolute(relative))) this.#deny();
    }
    return candidate;
  }

  #deny() {
    // Do not reflect credential filenames or caller-supplied paths in errors.
    throw new Error('Path is excluded by the native read policy');
  }
}
