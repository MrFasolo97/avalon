const fs = require('fs')
let c = fs.readFileSync('/avalon/src/config.js', 'utf8')
c = c.replace(
  '241600: {',
  '100: {\n            forceFinalize: true,\n        },\n        241600: {'
)
fs.writeFileSync('/avalon/src/config.js', c)
console.log('Patched forceFinalize activation at block 100')
