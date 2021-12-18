// Oct 09 2020 (danie) - created eth db 
const ethereumw = require("ethereumjs-wallet");

const logger = require("../../../config/winston-job.js");
const secUtil = require("../security_utils");

module.exports = {
  isApprovedAddress: async (db, spender, approver) => {
    const approvedCol = db.collection("approved_address");
    const approveRec = await approvedCol.findOne({ spender, approver, status: "L" });
    return !!approveRec;
  },
  hasPendingApproval: async (db, spender, approver) => {
    const approveRec = await db.collection("transaction")
      .findOne({sender: approver, recepient: spender, txnType: "APPROVE", status: "P"});
    return !!approveRec;
  },
  async getEthWithdrawWallet(type, db) {
    var hotAddress;
    if (process.env.USES_BIND_WALLET_WD === "Y") {
      // get the wallet details from the config file if withdrawals are from a single wallet
      hotAddress = {
        type,
        address: process.env.ETH_HOT_WALLET,
        key: process.env.ETH_HOT_WALLET_SECRET,
      };
      logger.debug("Using hot wallet for withdraw request " + process.env.ETH_HOT_WALLET);
    } else {
      // generate the wallet and store it into the database
      let keyPair = ethereumw.generate();
      hotAddress = {
        type,
        address: keyPair.getAddressString(),
        key: keyPair.getPrivateKeyString(),
      };
  
      let wallet = {
        type, use: "W",
        address: keyPair.getAddressString(),
        private: secUtil.encryptKey(keyPair.getPrivateKeyString())
      };
      await db.collection("address").insert(wallet);
      logger.info("ETH address generated: " + wallet.address);
    }
    return hotAddress;
  }
};