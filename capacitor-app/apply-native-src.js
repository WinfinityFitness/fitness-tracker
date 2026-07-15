// Copies tracked custom native source/resources over the generated android/
// project. Needed because android/ is gitignored (regenerable build output)
// and `npx cap add android` / `capacitor update` overwrite generated files
// (MainActivity.java, styles.xml, etc.) with fresh boilerplate — this is
// what puts the real, hand-written pieces back in place afterward:
//   native-src/    -> android/app/src/main/java/   (POST_NOTIFICATIONS request)
//   native-res/    -> android/app/src/main/res/    (clean centered splash, not
//                                                    Capacitor's default stretched one)
//   native-config/ -> android/app/                 (google-services.json — Firebase
//                                                    Cloud Messaging for native push)
const fs = require('fs');
const path = require('path');

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

copyRecursive(path.join(__dirname, 'native-src'), path.join(__dirname, 'android', 'app', 'src', 'main', 'java'));
copyRecursive(path.join(__dirname, 'native-res'), path.join(__dirname, 'android', 'app', 'src', 'main', 'res'));
copyRecursive(path.join(__dirname, 'native-config'), path.join(__dirname, 'android', 'app'));
