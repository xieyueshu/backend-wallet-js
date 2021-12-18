// Sep 8 2020 (danie) - added file
// Sep 14 2020 (danie) - added TRC 20 support
// Sep 15 2020 (danie) - added resource management
// Sep 16 2020 (danie) - added unfreezing of TRX
// Sep 29 2020 (danie) - changed wallet generation to not use API and added checking of balance on activation
// Oct 08 2020 (danie) - added burning of TRX for energy
// Oct 28 2020 (danie) - removed creation of tronweb if TRX is not supported
// Nov 03 2020 (danie) - removed sending of TRX on creation of wallet
const BigNumber = require("bignumber.js");

const secUtil = require("./security_utils");
const dbUtils = require("./db_utils");

const createHelper = require("./chain_lib/create_wallet.helper");
const sendHelper = require("./chain_lib/chain_send.helper");
const tronSend = require("./tron_lib/send.helper");
const constants = require("./tron_lib/constants");
const logger = require("../../config/winston");
const scan = require("./tron_lib/scan");

const toRawContractAmt = (amt) => constants.TRC20_DECIMAL.times(amt).toString();
const fromRawContractAmt = (amt) => new BigNumber(amt).div(constants.TRC20_DECIMAL).toString();

module.exports = {
  freezeForAccount: tronSend.freezeForAccount,
  getBalance: tronSend.getBalance,
  isTrcToken: (symbol) => symbol === process.env.TRX_CONTRACT_SYMBOL || symbol === "TRC20",
  isTronType: (type) => type === "TRX" || module.exports.isTrcToken(type),
  getActualAmount: (amt) => new BigNumber(amt).div(constants.TRX_DECIMAL).toString(),
  getTransactionInfo: async(txnId) => constants.tronWeb.trx.getTransactionInfo(txnId),
  createWallet: async (res, db, type) => {
    const account = constants.tronWeb.utils.accounts.generateAccount();
    const address = account.address;
    const addressRec = {
      type: type === "TRX" ? "TRX" : "TRC20",
      use: "D",
      address: address.base58,
      hexAddress: address.hex,
      private: secUtil.encryptKey(account.privateKey),
      activated: type === "TRX" ? true : false,
    };
    logger.info("TRX address generated: " + address.base58);
    
    const success = await createHelper.insertIntoDb(addressRec, db, res);
    if(!success) return;
    createHelper.sendAddressAndBackUpToFile(addressRec);

    createHelper.encryptSecretForResponse(addressRec, account.privateKey, false, null);
    addressRec.type = (addressRec.type === "TRC20" && process.env.TRX_USE_CONTRACT_SYMBOL === "Y") ? process.env.TRX_CONTRACT_SYMBOL : addressRec.type;
    return createHelper.sendReponse(addressRec, res);
  },
  getTokenBalance: async (wallet) => {
    const acct = await scan.getAccount(wallet);
    const balances = acct.trc20token_balances;
    const tokenBalance = balances.filter(b => b.contract_address === process.env.TRX_CONTRACT_ADDRESS || b.tokenId=== process.env.TRX_CONTRACT_ADDRESS);
    if(tokenBalance.length === 0) return "0";
    return fromRawContractAmt(tokenBalance[0].balance);
  },
  isAddress: async (address) => {
    try {
      await constants.tronWeb.trx.getAccount(address);
      return true;
    } catch (e) {
      if(e.search("Invalid address") !== -1) {
        return false;
      } else {
        throw e;
      }
    }
  },
  send: async (db, wallet) => {
    logger.info(`tron_utils.send - Sending ${wallet.amount} ${wallet.type} from ${wallet.fromAddress} to ${wallet.toAddress}`);
    let txnId = ""; 
    if(wallet.type === "TRX") {
      const txn = await tronSend.getTxnData(wallet, constants.tronWeb);
      txnId = txn.txID;
      const signedTxn = await constants.tronWeb.trx.sign(txn,wallet.key);
      await constants.tronWeb.trx.sendRawTransaction(signedTxn);
    } else {
      constants.tronWeb.setPrivateKey(wallet.key);
      const contract = await constants.tronWeb.contract().at(process.env.TRX_CONTRACT_ADDRESS);
      try {
        txnId = await contract.transfer(wallet.toAddress, toRawContractAmt(wallet.amount)).send();
      } catch(err) {
        logger.error("unable to send token : " + JSON.stringify(err));
        throw err;
      }
      // set the type that will be stored to TRC20
      wallet.type = "TRC20";
    }
    
    logger.info("Transaction with ID " + txnId + " created");
    let record = sendHelper.getTransactionDetails(wallet, txnId);
    await sendHelper.insertSendTransaction(db, record);

    return record;
  },
  createWithdrawRequest: async (withdraw, db, after) => {
    try {
      const coinType = withdraw.type.toUpperCase() === "TRX" ? "TRX" : "TRC20";
      logger.debug("tron_utils.createWithdrawRequest - Create TRX withdraw request");
      const hotAddress = { address: process.env.TRX_HOT_WALLET, key: process.env.TRX_HOT_WALLET_SECRET };
      const processed = await dbUtils.processWithdrawRequestList(db, module.exports, after, withdraw.request);
      if(!processed) return;
      const totalAmount = processed.totals.totalAmount.toString();
      // oct 26 2020 (danie) - added totalAmount as param
      const approvedStatus = await dbUtils.getWithdrawApprovalStatus(withdraw, coinType, totalAmount);

      const requestDetails = await dbUtils.insertWithdrawRequest(db, processed, coinType, approvedStatus, hotAddress.address);
      after(requestDetails);
      logger.debug("tron_utils.createWithdrawRequest - inserted request: " + JSON.stringify(requestDetails));
    } catch (err) {
      logger.error("tron_utils.createWithdrawRequest - " + err.stack);
      after({
        error: "An error occurred while processing the request"
      });
    }
  },
  getTransactionList: async(startBlk, endBlk) => {
    try {
      let blockNum = startBlk;
      let txnList = [];
      // Oct 7 2020 (danie) - added logging
      while(blockNum <= endBlk) {
        const block = await scan.getBlock(blockNum);
        txnList = txnList.concat(block);
        logger.debug("tron_utils.getTransactionList - retrieved " + block.length + " transactions for " + blockNum);
        blockNum++;
      }
      if(startBlk !== endBlk) {
        logger.debug("tron_utils.getTransactionList - Found " + txnList.length + " transactions");
      }
      return txnList;
    } catch(e) {
      logger.error("tron_utils.getTransactionList - error retreiving data: " + e.stack);
      throw e;
    }
  },
  getLastBlockNum: async () => {
    const block = await constants.tronWeb.trx.getCurrentBlock();
    const blockNum = block.block_header.raw_data.number;
    return blockNum - parseInt(process.env.TRX_CONFIRMATION_COUNT);
  },
  transferToCold: async(db, unsentList) => {
    for(const addr in unsentList) {
      const addrRec = unsentList[addr];
      let unsent = addrRec.unsent;
      if(new BigNumber(unsent).lt(constants.COIN_TRANSFER_MIN) || new BigNumber(unsent).eq(0)) {
        logger.debug(`Address ${addr} doesn't meet minimum coin amount transfer: ${unsent}/${constants.COIN_TRANSFER_MIN.toString()}`);
        continue;
      }
      try {
        const resources = await module.exports.checkAccountResources(addr);
        const walletSend = await tronSend.getTransferData(addr, db, addrRec, resources);
        if(walletSend){ 
          await module.exports.send(db, walletSend);
          // if T it means transfer and not activate/energy
          if(walletSend.use === "T") {
            await dbUtils.deductUnsent(db, addr, unsent);
          }
        }
      } catch (e) {
        logger.error("tron_utils.transferToCold - Error sending out from " + addr + ": " + e.stack||e.message);
      }
    }
    
  },
  // Oct 15 2020 (danie) - Removed retrieval of event per transaction
  getEventByTxnId: async (txn) => {
    if(txn.tokenTransfer && txn.tokenTransfer.length > 0) {
      return txn.tokenTransfer.map(tx => {
        return {
          from: tx.from,
          toAddress: tx.to,
          amount: fromRawContractAmt(tx.value),
          block: txn.block,
          timestamp: txn.timestamp
        };
      });
    }
    return [];
  },
  checkAccountResources: async(wallet, type, multiplier = 1) => {
    const account = await constants.tronWeb.trx.getAccountResources(wallet);
    const bandwidthLeft = ((account.freeNetLimit || 0) + (account.NetLimit || 0)) - ((account.NetUsed || 0) + (account.freeNetUsed || 0));
    const hasEnoughBandwidth = new BigNumber(bandwidthLeft).gte(constants.BANDWIDTH_REQ.times(multiplier));
    const energyLeft = account.EnergyLimit || 0 - account.EnergyUsed || 0;
    const hasEnoughEnergy = new BigNumber(energyLeft).gte(constants.ENERGY_REQ.times(multiplier));
    if(type === "TRX") return { energy: true, bandwidth: hasEnoughBandwidth};
    // if burning trx for energy we check the trx needed
    if(process.env.TRX_BURN_ENERGY === "Y") {
      const bal = await module.exports.getBalance(wallet);
      const burnEnergy = new BigNumber(await constants.tStation.energy.burnedEnergy2Trx(constants.ENERGY_REQ.times(multiplier).toNumber())).dp(5);
      return { energy: burnEnergy.lte(bal), bandwidth: hasEnoughBandwidth };
    }
    return { energy: hasEnoughEnergy, bandwidth: hasEnoughBandwidth };
  },
  // Sep 23 2020 (danie) - separated unfreeze for bandwidth and energy
  unfreezeBalance: async(db) => {
    const threeDaysAgo = new Date(), txnCollection = db.collection("transaction");
    threeDaysAgo.setDate(threeDaysAgo.getDate()-3);
    logger.info(`Unfreeze transactions for ${threeDaysAgo}`);
    const frozenTxns = await txnCollection.find({txnType: {$in: ["ENERGY", "BANDWIDTH"]}, unfrozen: {$exists: false}, timeStamp: {$lt:threeDaysAgo.getTime()/1000}}).toArray();
    logger.info(`Found ${frozenTxns.length} transactions to unfreeze`);
    
    const energyAmount = {}, bwAmount = {};
    for(const frozen of frozenTxns) {
      if(frozen.txnType === "ENERGY") {
        energyAmount[frozen.recepient] = (energyAmount[frozen.recepient] || 0) + frozen.amount;
      } else {
        bwAmount[frozen.recepient] = (bwAmount[frozen.recepient] || 0) + frozen.amount;
      }
    }
    await performUnfreeze(db, threeDaysAgo, energyAmount, "ENERGY");
    await performUnfreeze(db, threeDaysAgo, bwAmount, "BANDWIDTH");
  },
};

// Sep 23 2020 (danie) - created method for unfreezing balances
const performUnfreeze = async (db, timeLimit, frozenList, resource) => {
  const wallet = {
    resource,
    amount: 0,
    fromAddress: process.env.TRX_HOT_WALLET,
    key: process.env.TRX_HOT_WALLET_SECRET,
    use: "UNFREEZE",
    type: "TRX"
  };
  for (const frozenAddr in frozenList) {
    wallet.amount = frozenList[frozenAddr];
    wallet.toAddress = frozenAddr;
    await module.exports.send(db, wallet);
    await db.collection("transaction")
      .updateMany({txnType: resource, unfrozen: {$exists: false}, timeStamp: {$lt:timeLimit.getTime()/1000}, recepient:frozenAddr}, {$set:{unfrozen: true}});
  }
};
