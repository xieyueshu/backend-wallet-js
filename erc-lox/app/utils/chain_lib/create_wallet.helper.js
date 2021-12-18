const mailUtil = require("../mail_utils");
const fileUtil = require("../file_utils");
const httpUtil = require("../http_utils");
const secUtil = require("../security_utils");

const logger = require("../../../config/winston-job.js");

module.exports = {
  sendAddressAndBackUpToFile(address){
    // send a copy of the address details via email
    mailUtil.sendAddressCopy(address);
    try {
      // append the generated address to a list of the generated addresses
      fileUtil.appendAddress(address);
    } catch (err) {
      logger.warn("createWalletHelper - Error on appending address to file: " + err.stack);
    }
    const addressDeepCopy = JSON.parse(JSON.stringify(address));
    httpUtil.exportAddress(addressDeepCopy);
  },

  encryptSecretForResponse(address, privateKey, returnPrivate, mnemonic) {
    delete address.use;
    delete address._id;
    if(returnPrivate) {
      address.private = secUtil.encryptSecret(privateKey);
      if(mnemonic) address.phrase = secUtil.encryptSecret(mnemonic);
    } else {
      delete address.private;
      delete address.phrase;
    }
  },

  async insertIntoDb(address, db, res) {
    try {
      await db.collection("address").insertOne(address);
      return true;
    } catch (err) {
      logger.error(err.stack);
      res.send({"error": "An error has occurred"});
      return false;
    }
  },

  sendReponse(address, res) {
    address.sign = secUtil.sign(address.address);
    logger.info("createWalletHelper - Sending to client: " + JSON.stringify(address));
    return res.send(address);
  }
};