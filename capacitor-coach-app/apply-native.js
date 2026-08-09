// Copies tracked custom native source/resources over the generated android/
// project -- needed because android/ is gitignored (regenerable build
// output) and `npx cap add android` / `npm run icons` overwrite generated
// files (MainActivity.java, the default stretched splash.png, etc.) with
// fresh boilerplate. Same technique as capacitor-app/apply-native-src.js.
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
// native-config/google-services.json -- Firebase Cloud Messaging for native
// push (see android/app/build.gradle's conditional google-services plugin
// block). Same convention as capacitor-app/apply-native-src.js's own
// native-config -> android/app copy.
if (fs.existsSync(path.join(__dirname, 'native-config'))) {
  copyRecursive(path.join(__dirname, 'native-config'), path.join(__dirname, 'android', 'app'));
}
