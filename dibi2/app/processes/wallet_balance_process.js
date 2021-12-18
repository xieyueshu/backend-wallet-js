require("dotenv").config();
const Web3 = require("web3");
const BigNumber = require("bignumber.js");

const MongoClient = require("mongodb").MongoClient;
const db = require("../../config/db");

const etherUtil = require("../utils/eth_utils");
const logger = require("../../config/winston");

logger.info("wallet_processes - Child process created");
MongoClient.connect(db.url, async (err, database) => {
  if (err) {
    logger.error("Unable to connect to database - " + err.stack);
    return;
  }
  logger.debug("wallet_processes - connected to database");
  const walletDb = database.db(db.name);
  await run(walletDb);
  database.close();
});

const sleep = (ms) => {
  return new Promise(resolve => setTimeout(resolve, ms));
};


/**
 *  get the amtc addresses that require gas for the deposit
 */
const run = async (db) => {
  logger.info("wallet_balance_process - Checking deposit addresses for untransferred deposit");
  // Sep 9 2020 (Danie) - Refactored web3 provider
  const web3 = new Web3(etherUtil.WEB3_PROVIDER);
  // get addresses that don't have pending outgoing transfer 
  let depositTxn = await db.collection("transaction").find({
    txnType: "T",
    status: "P"
  }).toArray();
  let pendingAdd = depositTxn.map(a => a.sender);
  pendingAdd = pendingAdd.concat(depositTxn.map(a => a.recepient));

  // get all amtc wallets that don't have any pending transfers
  let addrList = await db.collection("address").find({
    use: "D",
    type: "AMTC",
    address: {
      $nin: pendingAdd
    }
  }).toArray();
  console.log(`wallet_balance_process - checking ${addrList.length} addresses`);
  for (let i = 0; i < addrList.length; i++) {
    try {
      let addr = addrList[i];
      let tokens = await etherUtil.getTokenBalance(web3, addr.address);
      const tokenBalance = new BigNumber(tokens);
      console.log(`wallet_balance_process - ${addr.address} - ${tokens.toString()} tokens`);
      if(tokenBalance.isGreaterThan(0)) {
        await db.collection("address").findOneAndUpdate({address: addr.address}, {$inc:{unsent: tokenBalance.toNumber()}});
        logger.info(`wallet_balance_process - adding ${tokenBalance.toString()} unsent for address ${addr.address}`);
      }
    } catch (err) {
      logger.error(err.stack);
    }
    await sleep(300);
  }
  console.log("wallet_balance_process - Finished checking addresses");
};