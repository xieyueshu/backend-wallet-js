const BigNumber = require("bignumber.js");

const logger = require("../../../config/winston");
const dbUtils = require("../db_utils");
const secUtil = require("../security_utils");
const constants = require("./constants");

const fromRawAmount = (amt) => new BigNumber(amt).div(constants.TRX_DECIMAL).toString();
const toRawAmount = (amt) => constants.TRX_DECIMAL.times(amt).toString();

const tronWeb = constants.tronWeb;
const tStation = constants.tStation;

module.exports = {
  getBalance: async (wallet) => {
    const balance = await constants.tronWeb.trx.getBalance(wallet);
    return fromRawAmount(balance);
  },

  freezeForAccount: async(db, address, multiplier = 1) => {
    const isBurn = process.env.TRX_BURN_ENERGY === "Y";
    let use = isBurn ? "BURN_E" : "ENERGY";
    if(await dbUtils.hasPendingIncoming(db, address, use)) {
      logger.info("Found existing energy transaction for " + address);
      return false;
    }
    const account = await tronWeb.trx.getAccountResources(address);
    if(Object.keys(account).length === 0) return false;
    let energyTrx = 0;
    if(isBurn) {
      energyTrx = await tStation.energy.burnedEnergy2Trx(constants.ENERGY_REQ.times(multiplier).toNumber());
    } else {
      energyTrx = await tStation.energy.frozenEnergy2Trx(constants.ENERGY_REQ.times(multiplier).toNumber());
    }
    energyTrx = new BigNumber(energyTrx).dp(5).toNumber();
    const balance = await module.exports.getBalance(process.env.TRX_HOT_WALLET);
    logger.debug(`Freezing req: ${energyTrx}, balance: ${balance}`);
    if(new BigNumber(balance).lt(energyTrx)) return false;
    return {
      use,
      fromAddress: process.env.TRX_HOT_WALLET,
      toAddress: address,
      key: process.env.TRX_HOT_WALLET_SECRET,
      amount: energyTrx,
      type: "TRX"
    };
  },

  async getTransferData(addr, db, addrRec, resources) {
    if (!resources.bandwidth) { // since deposits don't need to transfer often in a single day, we'll only activate it
      logger.info(`Address ${addr} isn't activated. Activating...`);
      return await activateAccount(addr);
    } 
    
    if (!resources.energy) {
      logger.info(`Address ${addr} doesn't have enough energy. Freezing/Sending balance for account...`);
      return module.exports.freezeForAccount(db, addr);
    } 
  
    let key = addrRec.private;
    if (!key) {
      key = (await db.collection("address").findOne({ address: addr })).private;
    }
    const wallet = {
      fromAddress: addr,
      toAddress: process.env.TRX_COLD_WALLET,
      key: secUtil.decryptKey(key),
      amount: addrRec.unsent,
      use: "T",
      type: addrRec.type
    };
    logger.debug(`tron_utils.transferToCold - transferring ${addrRec.unsent} from ${addr}`);
    return wallet;
  },
  
  async getTxnData(wallet) {
    let txn = {};
    if (wallet.use === "ENERGY" || wallet.use === "BANDWIDTH") {
      logger.info(`tron_utils.send - freezing ${wallet.amount} for ${wallet.toAddress}`);
      txn = await tronWeb.transactionBuilder.freezeBalance(toRawAmount(wallet.amount), 3, wallet.use, wallet.fromAddress, wallet.toAddress);
    } else if (wallet.use === "UNFREEZE") {
      // Sep 23 2020 (danie) - fixed input for unfreeze
      logger.info(`tron_utils.send - unfreezing ${wallet.resource} ${wallet.amount} from ${wallet.toAddress}`);
      txn = await tronWeb.transactionBuilder.unfreezeBalance(wallet.resource, wallet.fromAddress, wallet.toAddress);
    } else {
      txn = await tronWeb.transactionBuilder.sendTrx(wallet.toAddress, toRawAmount(wallet.amount), wallet.fromAddress);
    }
    return txn;
  }
};

const activateAccount = async(address) => {
  //remove extra checking
  const account = await tronWeb.trx.getAccountResources(address);
  if (account) {
     logger.debug('account resource returned: ' +JSON.stringify(account));
   }
  if(Object.keys(account).length > 0) return;
  const balance = new BigNumber(await module.exports.getBalance(process.env.TRX_HOT_WALLET));
  if(balance.lt(0.01)){
    logger.info("Not enough balance in hot wallet for activation of: " + address);
    return;
  }
  return {
    fromAddress: process.env.TRX_HOT_WALLET,
    toAddress: address,
    key: process.env.TRX_HOT_WALLET_SECRET,
    amount: 0.01,
    use: "ACTIVATE",
    type: "TRX"
  };
};
