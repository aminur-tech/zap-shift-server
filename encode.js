const fs = require('fs');
const key = fs.readFileSync('./zab-shift-firebase-adminsdk-fbsvc-a62efd09f0.json', 'utf8')
const base64 = Buffer.from(key).toString('base64')
console.log(base64)