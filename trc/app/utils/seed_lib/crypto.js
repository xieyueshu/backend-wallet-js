const bcrypt= require("bcryptjs");
const CryptoJS = require("crypto-js");

bcrypt.setRandomFallback(randomBytesGenerator);

let _randomGenSeed = Date.now() * Math.random();

function hash(plaintext, additionalSeedSource){
  setAdditionalSeed(additionalSeedSource);
  const bcryptSaltRounds = 10; // TODO PROD at least 10 asyncly
  return bcrypt.hashSync(plaintext, bcryptSaltRounds);
}

function setAdditionalSeed(
  stringKeysAndValues,
  nonFiniteSeedForCoverage
){
  const s = stringKeysAndValues;
  const now = Date.now();
  let additionalSeed = now * Math.random() * (Math.random() * 10);
  if (nonFiniteSeedForCoverage != null)
    additionalSeed = nonFiniteSeedForCoverage;
  for (let key in s){
    if (s[key] == null) continue;
    additionalSeed +=
      (now % key.length)
      + 2147483646 * Math.random()
      - ((now % s[key].length) + 2147483646 * Math.random());
    if (!isFinite(additionalSeed))
      additionalSeed = _randomGenSeed / Date.now() / Math.random();
  }
  _randomGenSeed = additionalSeed;
}

function compare(plaintext, hash){
  return bcrypt.compareSync(plaintext, hash);
}

function randomBytesGenerator(
  len,
  nonFiniteSeedForCoverage
){
  let seed = _randomGenSeed * Date.now() * Math.random();
  if (nonFiniteSeedForCoverage != null) seed = nonFiniteSeedForCoverage;
  if (!isFinite(seed)) seed = _randomGenSeed / Date.now() / Math.random();

  _randomGenSeed = seed;
  
  const rg = new UR3CRandom(_randomGenSeed);
  const randBytes = new Array(len);
  for (let i = 0; i < len; ++i) randBytes[i] = Math.round(rg.next() % 255);
  return randBytes;
}

// https://gist.github.com/blixt/f17b47c62508be59987b
function UR3CRandom(seed){
  this._seed = seed % 2147483647;
}
UR3CRandom.prototype.next = function(){
  // between 1 and 2^32 - 2
  return (this._seed = (this._seed * 16807) % 2147483647);
};

function AESEncrypt(message, key){
  return CryptoJS.AES.encrypt(message, key).toString();
}

function AESDecrypt(message, key){
  let decrypted = "";
  try {
    const decryptedCryptoJSObject = CryptoJS.AES.decrypt(message, key);

    let isKeyCorrect =
      decryptedCryptoJSObject.sigBytes != null
      && decryptedCryptoJSObject.sigBytes > 0
      && decryptedCryptoJSObject.words != null;
    // NOTE correct instances where numberOfLessThan0words can be high
    // if (isKeyCorrect){
    //   const decryptedWordArray = decryptedCryptoJSObject.words;
    //   let numberOfLessThan0words = 0;
    //   for (let i = 0; i < decryptedWordArray.length; ++i){
    //     const w = decryptedWordArray[i];
    //     if (w < 0) numberOfLessThan0words++;
    //   }

    //   if (numberOfLessThan0words > 2) isKeyCorrect = false;
    // }

    if (isKeyCorrect)
      decrypted = decryptedCryptoJSObject.toString(CryptoJS.enc.Utf8);
  } catch (e){
    decrypted = ""; // means key was invalid
  }
  return decrypted;
}

module.exports = {
  hash: hash,
  setAdditionalSeed: setAdditionalSeed,
  AESEncrypt:AESEncrypt,
  AESDecrypt:AESDecrypt,
  UR3CRandom:UR3CRandom,
  randomBytesGenerator:randomBytesGenerator,
  compare:compare
};