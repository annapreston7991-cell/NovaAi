/*
 * Real Name & Secrets Sanitization Check for nova-ai
 */

const fs = require('fs');
const path = require('path');

const BANNED_PATTERNS = [
  /\banna\s+preston\b/i,
  /\bione\s+fisher\b/i,
  /lily@llyversity\.com/i,
  /anna@llyverse\.org/i,
  /sk_live_[0-9a-zA-Z]{24}/,
  /rk_live_[0-9a-zA-Z]{24}/,
  /whsec_[0-9a-zA-Z]{24}/,
  /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/
];

const IGNORED_DIRS = ['node_modules', '.git'];

function scanDir(dir) {
  let violations = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (IGNORED_DIRS.includes(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      violations = violations.concat(scanDir(fullPath));
    } else if (entry.isFile()) {
      if (entry.name.endsWith('.JPG') || entry.name.endsWith('.jpg') || entry.name.endsWith('.png') || entry.name.endsWith('.ipynb')) {
        continue;
      }
      const content = fs.readFileSync(fullPath, 'utf8');
      BANNED_PATTERNS.forEach((pat) => {
        if (pat.test(content)) {
          violations.push({ file: fullPath, pattern: pat.toString() });
        }
      });
    }
  }
  return violations;
}

console.log('🔍 Running nova-ai Name & Secret Sanitization Check...');
const violations = scanDir(path.join(__dirname, '..'));

if (violations.length > 0) {
  console.error('❌ FAIL: Found prohibited personal names or secrets:');
  violations.forEach(v => console.error(`  - ${v.file}: matches ${v.pattern}`));
  process.exit(1);
} else {
  console.log('✅ PASS: nova-ai repository is completely clean of personal names and secrets.');
  process.exit(0);
}
