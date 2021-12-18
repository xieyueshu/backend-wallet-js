const Web3 = require("web3");
const BigNumber = require("bignumber.js");

const MongoClient = require("mongodb").MongoClient;
const db = require("../../config/db");

const etherUtil = require("../utils/eth_utils");
const amtUtil = require("../utils/amt_utils");
const btcUtil = require("../utils/btc_utils");
const secUtil = require("../utils/security_utils");
const settingUtil = require("../utils/setting_utils");
const logger = require("../../config/winston");

logger.info("wallet_processes - Child process created");
global.APP_HASH = process.argv[2];
global.SHARED_KEY = process.argv[3];
MongoClient.connect(db.url, async (err, database) => {
  if (err) {
    logger.error("Unable to connect to database - " + err.stack);
    return;
  }

  logger.debug("wallet_processes - connected to database");
  const walletDb = database.db(db.name);
	
  // Sep 10 2020 (danie) - loaded the system addresses
  await settingUtil.loadSystemWallets(walletDb);

  let method = process.argv[3];
  if (method === "sendGasToAmtc")
    sendGasToAmtcDeposit(walletDb);
  else if (method === "forwardDeposit")
    forwardDeposit(walletDb);
});


/**
 *  get the amtc addresses that require gas for the deposit
 */
const sendGasToAmtcDeposit = async (db) => {
  logger.info("wallet_processess.sendGasToAmtcDeposit - sending gas eth to AMTC wallets");
  // Sep 9 2020 (Danie) - Refactored web3 provider
  const web3 = new Web3(etherUtil.WEB3_PROVIDER);
  // get the amount that will be transferred
  // Sep 16 2020 (danie) - changed gas amount to be based on current gas prices
  const gasAmtTransfer = await etherUtil.getGasInEth(db, web3);
  // get the minimum amount of gas; refill if there isn't enough eth
  const minGas = BigNumber(process.env.ETH_HOT_GAS_MIN);
  // get the minimum amount of tokens
  const minAmtc = BigNumber(process.env.ETH_GAS_AMTC_MIN);
  let depositTxn = await db.collection("transaction").find({
    txnType: "T",
    status: "P"
  }).toArray();
  let pendingAdd = depositTxn.map(a => a.sender);

  // get all amtc wallets that don't have any pending transfers
  let addrList = await db.collection("address").find({
    use: "D",
    type: "AMTC",
    address: {
      $nin: pendingAdd
    }
  }).toArray();
  for (let i = 0; i < addrList.length; i++) {
    try {
      let addr = addrList[i];
      let weiResult = await etherUtil.getBalance(web3, addr.address);
      let ethBalance = BigNumber(web3.fromWei(weiResult, "ether"));
      let tokens = await etherUtil.getTokenBalance(web3, addr.address);
      if (tokens.gt(minAmtc) && ethBalance.lt(minGas)) {
        logger.debug("wallet_processess.getAmtcDepositGasWallet - Enough tokens and not enough gas for " + addr.address);
        logger.debug("wallet_processes.getAmtcDepositGasWallet - Tokens " + tokens);
        logger.debug("wallet_processes.getAmtcDepositGasWallet - Found " + ethBalance + " ETH for " + addr.address);

        let wallet = {
          fromAddress: process.env.ETH_HOT_WALLET,
          toAddress: addr.address,
          key: process.env.ETH_HOT_WALLET_SECRET,
          amount: gasAmtTransfer.toString(),
          use: "T",
          type: "ETH"
        };
        try {
          logger.debug("wallet_processess.sendGasToAmtcDeposit - Transferring " + gasAmtTransfer.toString() + " ETH to " + addr.address);
          // send eth to the amtc wallet
          await etherUtil.send(db, wallet, null);
        } catch (err) {
          logger.error(err.stack);
        }

      }
    } catch (err) {
      logger.error(err.stack);
    }
  }
  logger.info("wallet_processess.sendGasToAmtcDeposit - Finished sending ETH to AMTC wallets");
  process.send("DONE");
};

/**
 * Forward all deposits made in generated hot wallets to a defined cold wallet
 */
const forwardDeposit = async (db) => {
  logger.info("wallet_processess.forwardDeposit - Forwarding deposit to cold wallet");
  try {
    // Sep 9 2020 (Danie) - Refactored web3 provider
    const web3 = new Web3(etherUtil.WEB3_PROVIDER);
    // get all addresses with pending deposit transactions 
    let depositTxn = await db.collection("transaction").find({
      txnType: "T",
      status: "P"
    }).toArray();
    let pendingAdd = depositTxn.map(a => a.sender);
    logger.debug("wallet_processess.forwardDeposit - Addresses with Pending Deposit: " + JSON.stringify(pendingAdd));

    // retrieve all AMTC-deposit related addresses that don't have a pending deposit transaction
    let addrList = await db.collection("address").find({
      use: "D",
      address: {
        $nin: pendingAdd
      }
    }).toArray();
    logger.debug("wallet_processess.forwardDeposit - Found " + addrList.length + " addresses");
    for (let i = 0; i < addrList.length; i++) {
      let addr = addrList[i];
      addr.private = secUtil.decryptKey(addr.private);
      logger.debug(JSON.stringify(addr));
      if (addr.type === "AMTC")
        await etherUtil.transferToColdErc(addr, db, web3);
      else if (addr.type === "ETH")
        await sendEth(addr, db, web3);
      else if (addr.type === "AMT")
        await sendAmt(addr, db);
      else if (addr.type === "BTC")
        await sendBtc(addr, db);
    }
  } catch (err) {
    logger.error("wallet_processess.forwardDeposit error: " + err.stack);
  }
  logger.info("wallet_processess.forwardDeposit - Finished forwarding deposit to cold wallet");
  process.send("DONE");
};


/**
 * send ETH to the cold wallet
 * 
 * @param {address of the generated wallet} addr 
 * @param {db object for performin database-related methods} db 
 * @param {web3 object for calling methods on the Ethereum blockchain} web3 
 */

const sendEth = async (addr, db, web3) => {
  // get the ETH balance 
  let weiResult = await etherUtil.getBalance(web3, addr.address);
  let ethBalance = BigNumber(web3.fromWei(weiResult, "ether"));

  if (ethBalance.gt(BigNumber(process.env.ETH_HOT_GAS_MIN))) {
    logger.debug("wallet_processess.sendEth - There is enough ETH to make a transfer from " + addr.address);
    logger.debug("wallet_processess.sendEth - " + addr.address + " has " + ethBalance.toString() + " ETH");
    let ethSend = ethBalance.minus(BigNumber(process.env.ETH_HOT_GAS_MIN));
    let transfer = Object.assign(addr, {
      amount: ethSend.toNumber()
    });
    try {
      await etherUtil.transferToColdEth(db, transfer);
      await db.collection("address").findOneAndUpdate({
        address: addr.address
      }, {
        $set: {
          unsent: 0
        }
      });
    } catch (err) {
      logger.error("wallet_processes.sendEth send error: " + err.stack);
    }
  }

};

/**
 * send Amt to the cold wallet
 * 
 * @param {address of the generated wallet} addr 
 * @param {db object for performin database-related methods} db 
 * @param {web3 object for calling methods on the Ethereum blockchain} web3 
 */

const sendAmt = async (addr, db) => {
  // get the Amt balance 
  let amtBal = await amtUtil.getBalance(addr.address);
  amtBal = BigNumber(amtBal);
  logger.debug("wallet_processess.sendAmt - " + addr.address + " has " + amtBal.toString() + " AMT");

  if (amtBal.gt(BigNumber(process.env.AMT_FEE_MIN))) {
    logger.debug("wallet_processess.sendAmt - There is enough AMT to make a transfer from " + addr.address);
    logger.debug("wallet_processess.sendAmt - " + addr.address + " has " + amtBal.toString() + " AMT");
    let transfer = Object.assign(addr, {
      amount: amtBal.toNumber()
    });
    try {
      await amtUtil.transferToCold(db, transfer);
      await db.collection("address").findOneAndUpdate({
        address: addr.address
      }, {
        $set: {
          unsent: 0
        }
      });
    } catch (err) {
      logger.error("wallet_processes.sendAmt send error: " + err.stack);
    }
  }
};

const sendBtc = async (addr, db) => {
  if (!addr.unsent || addr.unsent === 0) return;
  await btcUtil.forwardDeposit(db, addr);
  await db.collection("address").findOneAndUpdate({
    address: addr.address
  }, {
    $set: {
      unsent: 0
    }
  });
};