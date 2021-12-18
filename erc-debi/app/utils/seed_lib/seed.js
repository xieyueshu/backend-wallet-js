const bip39 = require("bip39");
const networks = require("bitcoinjs-lib").networks;
const bip32 = require("bitcoinjs-lib").bip32;
const payments = require("bitcoinjs-lib").payments;
const UR3C = require("./crypto.js");

const ENGLISH = "english";

function generateWalletAndPrivateKeyFromPhrase(
  phrase) {
  const bip39Language = ENGLISH;
  if (!bip39.validateMnemonic(phrase, bip39.wordlists[bip39Language]))
    throw "invalidsecretphrase";

  const passphrase = "";    
    
  let walletAddress = "N/A",
    privateKey = "N/A",
    publicKey="N/A";
    
  var path= "m/44'/0'/0'/0/0";
  const result= bip39.mnemonicToSeed(phrase.trim(), passphrase).then(seed => {
    const root  = bip32.fromSeed(seed,networks.bitcoin);    
    const keyPair = root.derivePath(path);
    privateKey = keyPair.toWIF();        
    walletAddress = payments.p2pkh({ pubkey:keyPair.publicKey });     
    publicKey = keyPair.publicKey.toString("hex");
    const w = {
      "address":walletAddress.address,
      "privateKey": privateKey,
      "publicKey":publicKey,
      "phrase" : phrase
    };    
    return w;
        
  });
    
  return result;
}

function generateWithSeedSource(
  seedSource) {
  const bip39Language = ENGLISH;

  UR3C.setAdditionalSeed(seedSource);

  const twelveWords = bip39.generateMnemonic(
    128,
    UR3C.randomBytesGenerator,
    bip39.wordlists[bip39Language]
  );

  return generateWalletAndPrivateKeyFromPhrase(twelveWords, ENGLISH);
}

module.exports = {
  genSeed: generateWithSeedSource,
  genFromPhrase: generateWalletAndPrivateKeyFromPhrase
};

// generateWithSeedSource('123').then(console.log);
// generateWalletAndPrivateKeyFromPhrase("board industry caution hobby early provide industry lobster inner glow detail gate").then(console.log);
