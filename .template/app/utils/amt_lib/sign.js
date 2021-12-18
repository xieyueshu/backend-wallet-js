"use strict";
var crypto = require("crypto"),
  secp256k1 = require("secp256k1");

var OPS = {
  "OP_PUSHDATA1": 76,
  "OP_PUSHDATA2": 77,
  "OP_PUSHDATA4": 78,
  "OP_DUP": 118,
  "OP_HASH160": 169,
  "OP_EQUALVERIFY": 136,
  "OP_CHECKSIG": 172
};

var HASH_TYPES = {
  "ALL": 0x1,
  "SINGLE|ANYONECANPAY": 0x83
};

var signTransaction = function (transaction, publicKey, privateKey) {
  var hashType = HASH_TYPES["ALL"];
  if (transaction.hashType) {
    hashType = HASH_TYPES[transaction.hashType];
  }

  let newScripts = [];
  let fromAddress = transaction.addressToSign;
  for (let index = 0, size = transaction.vin.length; index < size; index++) {
    let prevtx = transaction.prevtx[index].scriptPubKey;
    let found = false;
    for (let i = 0, s = prevtx.addresses.length; i < s; i++) {
      if (prevtx.addresses[i] == fromAddress) {
        found = true;
        break;
      }
    }
    if (!found) {
      continue;
    }

    let oldvin = transaction.vin;
    let oldvout = transaction.vout;
    if (hashType == HASH_TYPES["SINGLE|ANYONECANPAY"]) {
      // only include the first input and first output in the hash
      transaction.vin = [oldvin[0]];
      transaction.vout = [oldvout[0]];
    }

    let scriptPubkey = Buffer.from(prevtx.hex, "hex");

    for (let i = 0; i < size; i++) {
      delete transaction.vin[i].script;
    }
    transaction.vin[index].script = scriptPubkey;

    var hashForSignature = hash256(Buffer.concat([toBuffer(transaction), uint32Buffer(hashType)]));




    var signature = secp256k1.sign(hashForSignature, privateKey).signature;
    var signatureDER = secp256k1.signatureExport(signature);




    var scriptSignature = Buffer.concat([signatureDER, uint8Buffer(hashType)]); // public key hash input



    var scriptSig = Buffer.concat([pushDataIntBuffer(scriptSignature.length), scriptSignature, pushDataIntBuffer(publicKey.length), publicKey]);



    if (hashType == HASH_TYPES["SINGLE|ANYONECANPAY"]) {
      // only include the first input and first output in the hash
      transaction.vin = oldvin;
      transaction.vout = oldvout;
    }

    newScripts[index] = scriptSig;
  }
  for (let index = 0, size = transaction.vin.length; index < size; index++) {
    transaction.vin[index].script = newScripts[index];
  }



  var signedTransaction = toBuffer(transaction, true);





  return signedTransaction.toString("hex");
};

module.exports = {
  signTransaction
};

function toBuffer(transaction, includeOldScripts) {
  var chunks = [];

  chunks.push(uint32Buffer(transaction.version));
  chunks.push(varIntBuffer(transaction.vin.length));

  transaction.vin.forEach(function (txIn) {
    var hash = [].reverse.call(new Buffer(txIn.txid, "hex"));
    chunks.push(hash);
    chunks.push(uint32Buffer(txIn.vout)); // index

    if (txIn.script != null) {
      chunks.push(varIntBuffer(txIn.script.length));
      chunks.push(txIn.script);
    } else {
      if (includeOldScripts && txIn.scriptSig.hex.length > 0) {
        let oldScript = Buffer.from(txIn.scriptSig.hex, "hex");
        chunks.push(varIntBuffer(oldScript.length));
        chunks.push(oldScript);
      } else {
        chunks.push(varIntBuffer(0));
      }
    }

    chunks.push(uint32Buffer(txIn.sequence));
  });

  chunks.push(varIntBuffer(transaction.vout.length));
  transaction.vout.forEach(function (txOut) {
    // for some reason this method encodes the values as if it's in satoshis, so let's multiply that up to get native units
    // the multiplier is 10^8 for amberchain
    chunks.push(uint64Buffer(txOut.value * 100000000));

    var script = Buffer.from(txOut.scriptPubKey.hex, "hex");

    chunks.push(varIntBuffer(script.length));
    chunks.push(script);
  });

  chunks.push(uint32Buffer(transaction.locktime));

  return Buffer.concat(chunks);
}

function pushDataIntBuffer(number) {
  var chunks = [];

  var pushDataSize = number < OPS.OP_PUSHDATA1 ? 1 :
    number < 0xff ? 2 :
      number < 0xffff ? 3 :
        5;

  if (pushDataSize === 1) {
    chunks.push(uint8Buffer(number));
  } else if (pushDataSize === 2) {
    chunks.push(uint8Buffer(OPS.OP_PUSHDATA1));
    chunks.push(uint8Buffer(number));
  } else if (pushDataSize === 3) {
    chunks.push(uint8Buffer(OPS.OP_PUSHDATA2));
    chunks.push(uint16Buffer(number));
  } else {
    chunks.push(uint8Buffer(OPS.OP_PUSHDATA4));
    chunks.push(uint32Buffer(number));
  }

  return Buffer.concat(chunks);
}

function varIntBuffer(number) {
  var chunks = [];

  var size = number < 253 ? 1 :
    number < 0x10000 ? 3 :
      number < 0x100000000 ? 5 :
        9;

  // 8 bit
  if (size === 1) {
    chunks.push(uint8Buffer(number));

    // 16 bit
  } else if (size === 3) {
    chunks.push(uint8Buffer(253));
    chunks.push(uint16Buffer(number));

    // 32 bit
  } else if (size === 5) {
    chunks.push(uint8Buffer(254));
    chunks.push(uint32Buffer(number));

    // 64 bit
  } else {
    chunks.push(uint8Buffer(255));
    chunks.push(uint64Buffer(number));
  }

  return Buffer.concat(chunks);
}

function uint8Buffer(number) {
  var buffer = new Buffer(1);
  buffer.writeUInt8(number, 0);

  return buffer;
}

function uint16Buffer(number) {
  var buffer = new Buffer(2);
  buffer.writeUInt16LE(number, 0);

  return buffer;
}

function uint32Buffer(number) {
  var buffer = new Buffer(4);
  buffer.writeUInt32LE(number, 0);

  return buffer;
}

function uint64Buffer(number) {
  var buffer = new Buffer(8);
  buffer.writeInt32LE(number & -1, 0);
  buffer.writeUInt32LE(Math.floor(number / 0x100000000), 4);

  return buffer;
}

function hash256(buffer) {
  return sha256(sha256(buffer));
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest();
}