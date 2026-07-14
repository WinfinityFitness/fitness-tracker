// Copies tracked custom native source (native-src/) over the generated
// android/ project. Needed because android/ is gitignored (regenerable
// build output) and `npx cap add android` / `capacitor update` overwrite
// generated files like MainActivity.java with fresh boilerplate — this is
// what puts the real, hand-written logic (e.g. the POST_NOTIFICATIONS
// permission request) back in place afterward.
const fs = require('fs');
const path = require('path');

const srcRoot = path.join(__dirname, 'native-src');
const destRoot = path.join(__dirname, 'android', 'app', 'src', 'main', 'java');

function copyRecursive(src, dest) {
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(d, { recursive: true });
      copyRecursive(s, d);
    } else {
      fs.copyFileSync(s, d);
      console.log('applied', path.relative(__dirname, d));
    }
  }
}

copyRecursive(srcRoot, destRoot);
