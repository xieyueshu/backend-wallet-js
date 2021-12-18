require("dotenv").config();

const BigNumber = require("bignumber.js");

const MongoClient = require("mongodb").MongoClient;
const db = require("../../config/db");

const btcUtil = require("../utils/btc_utils");
const omniUtil = require("../utils/omni_utils");
const btcDb = require("../utils/btc_lib/btc_db_utils");
const dbUtil = require("../utils/db_utils");
const secUtil = require("../utils/security_utils");
const logger = require("../../config/winston");
const crypto = require("crypto");

global.APP_HASH = process.argv[2];
global.SHARED_KEY = process.argv[3];
// TEST!!
if(!global.APP_HASH) {
  global.APP_HASH = crypto.createHash("md5").update("pass").digest("hex");
}

MongoClient.connect(db.url, async (err, database) => {
  if (err) {
    logger.error("Unable to connect to database - " + err.stack);
    return;
  }

  logger.debug("btc_deposit_process - connected to database");
  const walletDb = database.db(db.name);
  try {
    await retrieveSkipped(walletDb);
  } catch (e) {
    logger.error(`btc_deposit_process - error while retrieving blocks: ${e.stack}`);
  }
  if(process.send) {
    process.send("DONE");
  } else {
    process.exit(0);
  }
});

// Oct 9 2020 (danie) - passed block hash when retrieving transaction list
const retrieveSkipped = async (db) => {
  let fromBlk = await db.collection("base").findOne({
    name: "lastBlkBtc"
  });
  let toBlk = await btcUtil.getLastBlock();
  logger.debug("btc_deposit_process - toBlk retrieved: " + toBlk);
  // get only the confirmed blocks
  toBlk = toBlk - parseInt(process.env.BTC_CONFIRMATION_COUNT);
  if (!fromBlk) {
    fromBlk = {
      value: toBlk
    };
  }
  if(toBlk - fromBlk.value > 10) {
    toBlk = fromBlk.value + 10;
    logger.debug("btc_deposit_process - block number is too big. Jumping to 10 blocks ahead of current.");
  }
  logger.debug("btc_deposit_process - BTC blocks: " + fromBlk.value + " - " + toBlk);
  let txnMapped = await btcUtil.getBlockTxns(fromBlk.value, toBlk);
  let txnHashList = Object.keys(txnMapped);
  txnHashList = await btcDb.filterProcessed(db, txnHashList, fromBlk.value);
  logger.debug("btc_deposit_process - BTC transactions: " + txnHashList.length);

  const btcWalletList = await dbUtil.getDepositAddr(db, "BTC");
  const omniWalletList = await dbUtil.getDepositAddr(db, "OMNI");
  logger.debug("btc_deposit_process - BTC Wallets to watch: " + btcWalletList.length);
  logger.debug("btc_deposit_process - OMNI Wallets to watch: " + omniWalletList.length);
  let height = fromBlk.value, txnCount = 0;
  for (let i = 0; i < txnHashList.length; i++) {
    try {
      const txnHash = txnHashList[i];
      const txn = await btcUtil.getTxnWithBlock(txnHash, txnMapped[txnHash].blockHash, txnMapped[txnHash].height);
      const vout = txn.vout;
      for (let v = 0; v < vout.length; v++) {
        let out = vout[v];
        if (out.scriptPubKey && out.scriptPubKey.addresses) {
          let txnAmt = out.value;
          let toAddr = out.scriptPubKey.addresses[0];
          if (btcWalletList.includes(toAddr)) {
            txn.to = toAddr;
            txn.amount = txnAmt;
            await btcDb.insertPendingTxn(db, txn);
          } else if (omniWalletList.includes(toAddr)) {
            await checkOmniTransaction(db, txn, toAddr);
          }
        }
      }
      await btcDb.insertProcessed(db, txn);
      if(height != txn.height) {
        logger.debug("btc_deposit_process - Processed " + txnCount + " txns for block: " + height);
        height = txn.height;
        logger.debug("btc_deposit_process - Starting Processing for block: " + height);
        txnCount = 0;
      }
      txnCount++;
    } catch (error) {
      if(error.code === -5) {
        logger.warn("btc_deposit_process - " + txnHashList[i] + " not a wallet transaction.");
      } else {
        logger.error("btc_deposit_process - error retrieving " + txnHashList[i] + ": " + error.stack);
      }
    }
    await sleep(50); // sleep to avoid the node from rejecting the requests
  }
  logger.debug("btc_deposit_process - Processed " + txnCount + " txns for block: " + height);
  logger.info("btc_deposit_process - updating last block to " + toBlk);
  await db.collection("base").update({
    name: "lastBlkBtc"
  }, {
    $set: {
      value: toBlk
    }
  }, {
    upsert: true
  });
  await db.collection("btc_blocks").remove({"number":{"$lt":toBlk-10}});
  logger.info("btc_deposit_process - removed btc_blocks less than " + (toBlk-10));

  if (process.env.MANUAL_DEPOSIT === "N") {
    await transferToCold(db);
  }
  
};

// sleep function
const sleep = (ms) => {
  return new Promise(resolve => setTimeout(resolve, ms));
};

const checkOmniTransaction = async(db, txn, address) => {
  const omniTxn = await omniUtil.getOmniTxn(txn.txid);
  if(!omniTxn) return;
  if (omniTxn.referenceaddress !== address) return;
  if(await dbUtil.hasSameDepositTxid(db, omniTxn.txid)) return;
  omniTxn.amount = new BigNumber(omniTxn.amount).toNumber();
  const dbTxn = {
    from: omniTxn.sendingaddress,
    to: address,
    gas: omniTxn.fee,
    hash: omniTxn.txid,
    timeStamp: omniTxn.blocktime,
    blockNumber: omniTxn.block,
    coin: "OMNI",
    amount: omniTxn.amount,
  };
  logger.info("btc_deposit_process - inserting omni deposit with hash: " + txn.txid);
  await dbUtil.createAndSendTxn(db, dbTxn, {});
  await db.collection("address").findOneAndUpdate({ address }, {$inc:{ unsent: omniTxn.amount }});
};

const transferToCold = async (db) => {
  const minOmni = new BigNumber(process.env.BTC_OMNI_MIN || 0);
  const unsent = {};
  if (minOmni.eq(0)) {
    unsent["$gt"] = 0;
  } else {
    unsent["$gte"] = minOmni.toNumber();
  }
  let walletList = await db.collection("address").find({
    use: "D", type: "BTC", unsent
  }).toArray();
  logger.info(`Found ${walletList.length} wallets with unsent`);
  for (const addr of walletList) {
    if(!await btcUtil.hasFundsForTransfer(addr.address)) {
      // Sep 15 2020 (danie) - changed input for pending incoming
      if(await dbUtil.hasPendingIncoming(db, addr.address, addr.type)) continue;
      const feeMin = new BigNumber(process.env.BTC_FEE_MIN).toNumber();
      logger.info(`omni wallet ${addr.address} doesn't have enough BTC for fee... transferring ${feeMin} BTC`);
      const wallet = {
        fromAddress: process.env.BTC_HOT_WALLET,
        toAddress: addr.address, 
        amount: feeMin,
        key: process.env.BTC_HOT_WALLET_SECRET,
        type: "BTC",
        use: "T"
      };
      try{
        await btcUtil.sendBtc(db, wallet);
      } catch (e) {
        logger.error(`Error sending gas to ${addr.address}: ${e.stack}`);
      }
    } else {
      addr.private = secUtil.decryptKey(addr.private);
      const cold = process.env.BTC_COLD_WALLET;
      logger.debug(`Sending ${addr.unsent} to ${cold}`);
      const wallet = {
        fromAddress: addr.address,
        key: addr.private,
        toAddress: cold,
        coin: addr.type,
        type: "BTC",
        use: "T"
      };
      let sent = [];
      try {
        sent = await btcUtil.sendBtc(db, wallet);
      } catch (err) {
        logger.warn("Error forwarding from " + addr.address + ": " + err.stack);
      }
      if(sent.length > 0) {
        logger.info(`Successfully sent ${sent[0].amount} from ${addr.address} with hash ${sent[0].txnHash}`);
        await db.collection("address").findOneAndUpdate(
          { address: addr.address }, { $set: { unsent: 0 } }
        );
      }
    }
  }
};