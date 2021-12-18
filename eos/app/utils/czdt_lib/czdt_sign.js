const logger = require("../../../config/winston");
const NodeRSA = require('node-rsa');
const sha256 = require('sha256');
const fs = require('fs');

const exczcPubkey = new NodeRSA(fs.readFileSync('config/keys/public_exczc.pem', 'utf8'));
exczcPubkey.setOptions({
  encryptionScheme: 'pkcs1'
});

module.exports = {
  verify: (data) => {
    try {
      let rawData = data.apiKey + "|" + data.address + "|" + data.amount + "|" + data.txnId;
      let hash = sha256(rawData, 'base64');
      logger.debug(`Raw data: ${rawData}; Hash: ${hash}`);

      let decrypted = exczcPubkey.decryptPublic(data.sign, 'utf8');
      logger.debug(`Sign: ${data.sign}; decrypted: ${decrypted}`)
      if (decrypted === hash)
        return true;
    } catch (e) {
      logger.error("Error while decrypting: " + e.stack);
    }
    return false;
  }
}