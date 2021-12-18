// Sep 8 2020 (danie) - added support for TRX
const fs = require("fs");
const Web3 = require("web3");
const BigNumber = require("bignumber.js");
const InputDataDecoder = require("ethereum-input-data-decoder");

const base = require("../utils/base_utils");
const amtUtil = require("../utils/amt_utils");
const btcUtil = require("../utils/btc_utils");
const dbUtil = require("../utils/db_utils");
const ethUtil = require("../utils/eth_utils");
const httpUtil = require("../utils/http_utils");
const secUtil = require("../utils/security_utils");
const tronUtil = require("../utils/tron_utils");
const filUtil = require("../utils/fil_utils");
const cp = require("child_process");

const logger = require("../../config/winston-job");

var child = null;
var isRunning = false;
var abiArray = JSON.parse(fs.readFileSync("resources/contract.json", "utf-8"));
const decoder = new InputDataDecoder(abiArray);
let amtAsset = null;

const TRX_DEPOSIT_QUEUE={};
const TRX_QUEUE_SIZE = parseInt(process.env.TRX_QUEUE_SIZE || "5");
const FIL_DEPOSIT_QUEUE={};
const FIL_QUEUE_SIZE = parseInt(process.env.FIL_QUEUE_SIZE || "5");

async function depositChecker(db) {
  if (!isRunning) {
    isRunning = true;
    logger.debug("deposit_checker_job- running");
    try {
      let isBind = process.env.USES_BIND_WALLET_D === "Y";
      let chainList = process.env.CHAIN_SUPPORT;
      if (chainList.includes("ETH"))
        await retrieveEthTxns(db, isBind);
      if (chainList.includes("AMT"))
        await retrieveAmtTxns(db, isBind);
      if (chainList.includes("BTC"))
        await retrieveBtcTxns(db, isBind);
      if (chainList.includes("TRX"))
        await retrieveTrxTxns(db);
      if (chainList.includes("FIL"))
        await retrieveFilTxns(db);
    } catch (err) {
      logger.error("deposit_checker_job - error: " + err.stack);
    }
    isRunning = false;
  } else {
    logger.debug("Skipped deposit_checker_job run due to ongoing operation");
  }

}

const getAmtSender = async function (txn) {
  let senders = [];
  for (let cnt = 0; cnt < txn.vin.length; cnt++) {
    let vin = txn.vin[cnt];
    try {
      if (vin.txid) {
        let inTxn = await amtUtil.getRawTransaction(vin.txid);
        let out = inTxn.vout[vin.vout].scriptPubKey.addresses;
        senders = senders.concat(out);
      }
    } catch (err) {
      logger.warn("deposit_checker_job - error while getting sender" + err.message);
    }
  }
  // filter out any undefined elements (from repeated vouts)
  senders = senders.filter(sender => sender !== undefined);
  // convert to set to remove repeated values and back to an array 
  senders = Array.from(new Set(senders));
  if (senders.length === 1) return senders[0];
  else return senders.toString();
};

const retrieveAmtTxns = async (db, bind) => {
  var txnHashList = [];
  let fromBlk = await dbUtil.getBaseItemValue(db, "lastBlkNumAtm");
  let lastBlkNum = await amtUtil.getLastBlock();
  let toBlk = lastBlkNum - parseInt(process.env.AMT_CONFIRMATION_COUNT);
  logger.debug("deposit_checker_job - From AMT blk num: " + fromBlk + "; To AMT blk num: " + toBlk);

  let rates = await db.collection("base").findOne({
    name: "exchangeRates"
  });
  rates = rates[process.env.DEFAULT_CURRENCY];

  // get the list of transaction hashes in the blocks
  for (var i = fromBlk; i < toBlk; i++) {
    logger.debug("deposit_checker_job - retrieving AMT block " + i);
    // 4 - verbose block information: include transaction data
    let block = await amtUtil.getBlock(i, 4);
    let txns = block.tx.map((tx) => {
      tx.time = block.time;
      tx.blockNumber = block.height;
      return tx;
    });
    txnHashList = txnHashList.concat(txns);
  }
  logger.debug("deposit_checker_job - Found " + txnHashList.length + "AMT transactions");

  amtAsset = base.getValueMem("asset");
  let walletList = [], walletRec = {};
  let txnDbList = await db.collection("transaction").find({
    txnType: "D",
    coinType: {$in: ["AMT", "AMT_A"]},
    status: "L"
  }).toArray();
  txnDbList = txnDbList.map(t => t.txnHash);
  if (bind) {
    walletList = [{
      address: process.env.AMT_COLD_WALLET,
      type: "AMT"
    },
    {
      address: process.env.AMT_COLD_ASSET_WALLET,
      type: "AMT_A"
    }];
  } else {
    // retrieve the addresses from the database
    walletList = await db.collection("address").find({
      use: "D", type: {$in: ["AMT", "AMT_A"]}
    }).toArray();
    walletList.map((w) => {
      walletRec[w.address] = {
        type: w.type,
        address: w.address,
        private: w.private,
        amount: w.unsent || 0
      };
      return w.address;
    });
  }
  // filter out the AMT addresses only
  const amtAddr = walletList.filter(a => a.type === "AMT").map(a => a.address);
  // filter out the AMT_A addresses only
  const assetAddr = walletList.filter(a => a.type === "AMT_A").map(a => a.address);
  logger.debug("deposit_checker_job - Number of amt addresses: " + amtAddr.length + "; AMT_A addresses: " + assetAddr.length);

  // go through all transactions retrieved
  for (let i = 0; i < txnHashList.length; i++) {
    let txn = txnHashList[i];
    // hash found in database; skip
    if (txnDbList.indexOf(txn.txid) !== -1) {
      logger.debug("deposit_checker_job - transaction " + txn.txid + " found in the database. Skipped.");
      continue;
    }
    let txid = txn.txid,
      timeStamp = txn.time,
      vout = txn.vout,
      blockNumber = txn.blockNumber;
    let txDeposit = {};
    let sender = await getAmtSender(txn);
    if (!sender) continue; // no sender so continue to next transaction
    logger.debug(`deposit_checker_job - senders of transaction: ${sender}`);
    // skip the last one since this is the sender's new balance
    for (let v = 0; v < vout.length; v++) {
      let out = vout[v];
      if (out.scriptPubKey && out.scriptPubKey.addresses) {
        // get addresses that aren't among the input addresses
        // and filter out addresses that aren't on the watch list
        const toAddr = out.scriptPubKey.addresses
          .filter(addr => sender.search(addr) === -1);
        // extract amtc and asset transfers for this vout
        if(toAddr.length > 0){
          const toAmt = toAddr.filter(addr => amtAddr.includes(addr));
          Object.assign(txDeposit, extractAddrAmts(toAmt, out));
          const toAsset = toAddr.filter(addr => assetAddr.includes(addr));
          Object.assign(txDeposit, extractAddrAmts(toAsset, out, true));
        }
      }
    }
    if (Object.keys(txDeposit).length > 0) {
      const txDetails = {bind, sender, txid, timeStamp, rates, blockNumber};
      await processDeposits(db, txDeposit, txDetails, walletRec);
    }

  }
  // send all deposits to the cold wallet automatically
  if (process.env.MANUAL_DEPOSIT === "N") { 
    // retrieve addresses that have deposits
    let depositedWallets = Object.keys(walletRec).filter(wallet => walletRec[wallet].amount > 0);
    for (let i = 0; i < depositedWallets.length; i++) {
      let wallet = depositedWallets[i];
      logger.info("deposit_checker_job - Forwarding " + walletRec[wallet].amount + " from " + walletRec[wallet].address);
      try {
        if(walletRec[wallet].type === "AMT_A") walletRec[wallet].asset = amtAsset.assetref;
        walletRec[wallet].private = secUtil.decryptKey(walletRec[wallet].private);
        await amtUtil.transferToCold(db, walletRec[wallet]);
        await dbUtil.deductUnsent(db, wallet, walletRec[wallet].amount);
      } catch (e) {
        logger.warn("deposit_checker_job - error forwarding deposit: " + e.stack);
      }
    }
  }

  logger.debug("deposit_checker_job - Last processed ATM block: " + toBlk);
  await db.collection("base").updateOne({
    name: "lastBlkNumAtm"
  }, {
    $set: {
      value: toBlk
    }
  });

};

const retrieveEthTxns = async (db, isBind) => {
  // retrieve the starting and ending block
  logger.debug("entering retrieveEthTxns");
  // Sep 9 2020 (Danie) - Refactored web3 provider
  const web3 = new Web3(ethUtil.WEB3_PROVIDER);
  var txnHashList = [];
  let fromBlk = await db.collection("base").findOne({
    name: "lastBlkNum"
  });
  logger.debug("deposit_checker_job - obtained lastBlkNum from db: " + fromBlk.value);
  let lastBlkNum = await ethUtil.getLatestBlock(web3);
  let toBlk = lastBlkNum - parseInt(process.env.ETH_CONFIRMATION_COUNT);
  if (toBlk - fromBlk.value > 30) {
    toBlk = fromBlk.value + 30;
  }
  logger.debug("deposit_checker_job - From blk num: " + fromBlk.value);
  logger.debug("deposit_checker_job - To blk num: " + toBlk);
  // get the list of transaction hashes in the blocks
  for (var i = fromBlk.value; i < toBlk; i++) {
    logger.debug("deposit_checker_job - retrieving block " + i);
    let block = await ethUtil.getBlock(web3, i, true);

    let txns = block.transactions.map((txn) => {
			
      if (txn.type == "rpctx" && txn.value.txType == "tx"){
        txn = txn.value.tx.value;
        txn.from = txn.value.from;
        txn = web3._extend.formatters.outputTransactionFormatter(txn);
      }

      txn.timeStamp = block.timestamp; 
      txn.blockNumber = block.number;
			
      return txn;

      // txn.timeStamp = block.timestamp;
      // return txn;
    });

    txnHashList = txnHashList.concat(txns);
  }
  logger.debug("deposit_checker_job - Found " + txnHashList.length + " transactions");

  let rates = await db.collection("base").findOne({
    name: "exchangeRates"
  });
  rates = rates[process.env.DEFAULT_CURRENCY];
  // retrieve the list of addresses from the database
  let addrList = [];
  let txnDbList = await db.collection("transaction").find({
    txnType: "D",
    coinType: {
      $in: ["AMTC", "ETH"]
    },
    status: "L"
  }).toArray();
  txnDbList = txnDbList.map(t => t.txnHash);
  if (isBind) {
    // Sep 10 2020 (danie) - changed variable names for system wallets
    addrList = [{
      address: process.env.ETH_COLD_WALLET,
      type: "AMTC"
    },
    {
      address: process.env.ETH_COLD_WALLET,
      type: "ETH"
    }
    ];
  } else {
    addrList = await db.collection("address").find({
      use: "D",
      type: {
        $in: ["AMTC", "ETH"]
      }
    }).toArray();
  }
  if (addrList.length !== 0) {
    // filter out the ETH addresses only
    let ethAddr = addrList.filter(a => a.type === "ETH").map(a => a.address.toLowerCase());
    logger.debug("deposit_checker_job - Number of eth addresses: " + ethAddr.length);
    // filter out the AMTC addresses only
    let amtcAddr = addrList.filter(a => a.type === "AMTC").map(a => a.address.toLowerCase());
    logger.debug("deposit_checker_job - Number of amtc addresses: " + amtcAddr.length);
    let markedAddr = await getMarkedAddresses(db);
    logger.debug("deposit_checker_job - Number of marked addresses: " + markedAddr.length);

    const contractAddr = process.env.ETH_CONTRACT_ADDRESS.toLowerCase();
    const ethDecPlaces = BigNumber(10).pow(BigNumber(18));
    for (let i = 0; i < txnHashList.length; i++) {
      let txn = txnHashList[i];
      if (txnDbList.indexOf(txn.hash) !== -1) {
        logger.debug("deposit_checker_job - transaction found in the database... skipping");
        continue; // move on to the next transaction
      }
      let to = txn.to;
      if (to) {
        to = to.toLowerCase();
        // if successful transaction, we check if the recipient is one of the addresses 
        // or the contract address
        if (contractAddr === to) {
          // the sent amount is in the token registered (AMTC)
          try {
            const result = decoder.decodeData(txn.input);
            if (result.inputs[0]) {
              // Oct 09 2020 (danie) - specified method for determining receiver of tokens
              let to = "";
              if(result.method === "transfer") {
                to ="0x" + result.inputs[0].toLowerCase();
              } else if (result.method === "transferFrom") {
                to ="0x" + result.inputs[1].toLowerCase();
              }
              if (amtcAddr.indexOf(to) !== -1) {
                // the token has been sent to a generated wallet
                logger.info("deposit_checker_job - found AMTC transaction for " + to + ": " + txn.hash);
                let receipt = await ethUtil.getReceipt(web3, txn.hash);
                if (receipt.status === "0x1") {
                  logger.debug("deposit_checker_job - Creating and sending AMTC transaction");
                  let amt = result.inputs[1].toString();
                  if(result.method === "transferFrom") {
                    amt = result.inputs[2].toString();
                  }
                  // compute the ETH used up in the transfer
                  txn.gas = ethUtil.getGasUsedUp(web3, receipt, txn);
                  const amtcAmt = ethUtil.getAMTCAmount(amt);
                  await createAndSendTxn(db, txn, {
                    coin: "AMTC",
                    amount: amtcAmt.toString(),
                    to,
                    rate: (rates) ? rates.amtc : 0,
                    isMarked: markedAddr.indexOf(to) !== -1
                  });
                  await dbUtil.addUnsent(db, to, amtcAmt.toString());
                }
              }
            }
          } catch (e){
            logger.error("unable to process txn : "+  txn.hash + " with error: " + e);
          }
        } else if (ethAddr.indexOf(to) !== -1) {
          // there has been an eth deposit into the generated wallet
          logger.info("deposit_checker_job - found ETH transaction for " + to + ": " + txn.hash);
          let receipt = await ethUtil.getReceipt(web3, txn.hash);
          // successful transaction so we send it to the client
          if (receipt.status === "0x1") {
            logger.debug("deposit_checker_job - Creating and sending ETH transaction");
            const ethAmt = BigNumber(txn.value).div(ethDecPlaces);
            txn.gas = ethUtil.getGasUsedUp(web3, receipt, txn);
            await createAndSendTxn(db, txn, {
              coin: "ETH",
              amount: ethAmt.toString(),
              rate: (rates) ? rates.eth : 0,
              isMarked: markedAddr.indexOf(to) !== -1
            });
            await dbUtil.addUnsent(db, to, ethAmt);
          }
        } else if(txn.input !== "0x") {
          const txns = await ethUtil.checkLog(web3, amtcAddr, txn);
          await processEthLogs(txns, txn, db, rates, markedAddr);
        }
      }
    }
  }

  logger.debug("deposit_checker_job - Last processed block: " + toBlk);
  await db.collection("base").updateOne(
    { name: "lastBlkNum" }, { $set: { value: toBlk } }
  );
};


const processEthLogs = async (txns, txn, db, rates, markedAddr) => {
  if (!txns || txns.length === 0) return;
  //handle multiple transfers in the same txn from defi
  let hash = txn.hash;
  for (let i = 0, j = txns.length; i < j; i++) {
    //append suffix if multiple txns
    if (i > 0)
      hash = txn.hash + "[" + i + "]";
    logger.info("deposit_checker_job - Found " + process.env.ETH_CONTRACT_SYMBOL + " transaction from logs of " + hash);
    let log = txns[i];
    const to = log.toAddress;
    txn.gas = log.gas;
    //copy the txn details and overwrite the hash
    let tmpTxn = Object.assign({}, txn, { hash: hash });
    await createAndSendTxn(db, tmpTxn, {
      to,
      amount: log.amount,
      coin: "AMTC",
      rate: (rates) ? rates.amtc : 0,
      isMarked: markedAddr.indexOf(to) !== -1
    });
    await dbUtil.addUnsent(db, to, log.amount);
  }
};

const createAndSendTxn = async (db, txn, det) => {
  let txnDetails = {
    txnType: "D",
    coinType: det.coin,
    sender: txn.from,
    recepient: det.to || txn.to,
    amount: det.amount,
    createTime: new Date(),
    gas: txn.gas || 0,
    nonce: txn.nonce || 0,
    txnHash: txn.hash,
    status: "L",
    timeStamp: txn.timeStamp,
    blockNumber: txn.blockNumber || 0,
  };
  if (det.rate) {
    txnDetails["RP"] = BigNumber(det.amount).times(BigNumber(det.rate)).toString();
    if (det.isMarked) {
      logger.debug("deposit_checker_job - found marked address. Sending extra IP");
      txnDetails["FP"] = BigNumber(txnDetails["RP"]).times(BigNumber("0.1")).toString();
    }
  }
  logger.debug("deposit_checker_job - " + JSON.stringify(txnDetails));

  await db.collection("transaction").insert(txnDetails);
  // send the transaction to the client
  httpUtil.sendTransaction(txnDetails, db);
};


const getMarkedAddresses = async (db) => {
  logger.debug("deposit_checker_job - Getting marked addresses from the database");
  let markedAddrDb = await db.collection("marked_address").find({}).toArray();
  if (markedAddrDb && markedAddrDb.length > 0) {
    return markedAddrDb.map(a => a.address.toLowerCase());
  } else {
    return [];
  }
};

const retrieveBtcTxns = async (db) => {
  if (process.env.BTC_INSIGHT_SUPPORT === "N") {
    if(child){
      logger.warn("deposit_checker_job - unable to run btc deposit due to ongoing process");
    } else {
      child = cp.fork("app/processes/btc_deposit_process.js", [global.APP_HASH, global.SHARED_KEY]);
      child.on("message", function(data) {
        logger.debug("deposit_checker_job - Received data from btc_deposit_process: " + data);
        if(data === "DONE"){
          logger.info("deposit_checker_job - Killing child btc_deposit_process");
          child.kill();
          child = null;
        }
      });
    }
  } else {
    if (process.env.MANUAL_DEPOSIT === "Y") return;
    let walletList = await db.collection("address").find({
      use: "D",
      type: {
        $in: ["BTC"]
      },
      unsent: {
        $gt: 0
      }
    }).toArray();
    for (let i = 0; i < walletList.length; i++) {
      let addr = walletList[i];
      addr.private = secUtil.decryptKey(addr.private);
      await btcUtil.forwardDeposit(db, addr);
      await db.collection("address").findOneAndUpdate({
        address: addr.address
      }, {
        $set: {
          unsent: 0
        }
      });
    }
  }
};

const extractAddrAmts = (toAddr, out, isAsset = false) => {
  if(toAddr.length === 0) return {};
  let deposits = {};
  let txnAmt = 0;
  if(isAsset && amtAsset && out.assets){
    txnAmt = out.assets
      .filter(a=>a.assetref === amtAsset.assetref)
      .map(a => a.qty)
      .reduce((total, qty) => total + qty, 0);
  }
  if(!isAsset && out.value > 0){
    txnAmt = out.value;
  } 
  toAddr.forEach((addr) => {
    if(txnAmt > 0) deposits[addr] = txnAmt;
  });
  return deposits;
};

const processDeposits = async (db, txDeposit, details, walletRec) => {
  const rates = details.rates;
  for (const addr in txDeposit) {
    const type = walletRec[addr].type;
    const amount = txDeposit[addr];
    // update in-memory list of unsent for auto-sending
    walletRec[addr].amount += amount;
    // create a deposit for all assets and AMTC received
    await createAndSendTxn(db, {
      from: details.sender, to: addr, 
      hash: details.txid, timeStamp: details.timeStamp,
      blockNumber: details.blockNumber
    }, {
      coin: type, amount: amount, 
      rate: (rates && type === "AMT") ? rates.amtc : 0
    });
    if (!details.bind) {
      await db.collection("address").findOneAndUpdate({
        address: addr
      }, {
        $set: {
          unsent: walletRec[addr].amount
        }
      });
    }
  }
};

// TRX Deposit Functions
// Oct 7 2020 (danie) - change retrieval of trx to use child processing
// Oct 8 2020 (danie) - added checking if process is existing and using upsert when creating block txns
const retrieveTrxTxns = async(db) => {
  // queue up the blocks
  let fromBlk = (await dbUtil.getBaseItemValue(db, "lastBlkTrx"));
  let toBlk = await tronUtil.getLastBlockNum();
  if(fromBlk > toBlk) fromBlk = toBlk;
  // Oct 15 2020 (danie) - clear out the done processes
  await db.collection("trx_block").remove({status:"DONE"});
	
  logger.debug("last block from db: "+ fromBlk + " from util: "+ toBlk);
  for(let blk = fromBlk; blk < toBlk; blk++) {
    await db.collection("trx_block").update({block: blk},{block:blk, status:"PENDING"}, {upsert:true});
  }
  logger.debug("deposit_checker_job - last block: " + toBlk);
  await db.collection("base").findOneAndUpdate({name:"lastBlkTrx"}, {$set:{value: toBlk}});

  const blockList = await db.collection("trx_block").find({status:{$nin:["DONE","PROCESSING"]}}).sort({block:1}).toArray();
  for(const rec of blockList) {
    const blockNum = rec.block;
    if(Object.keys(TRX_DEPOSIT_QUEUE).length < TRX_QUEUE_SIZE && !TRX_DEPOSIT_QUEUE[blockNum]) {
      const child = cp.fork("app/processes/trx_deposit_process.js",[global.APP_HASH, global.SHARED_KEY,blockNum]);
      await db.collection("trx_block").findOneAndUpdate({block: blockNum}, {$set:{status:"PROCESSING"}});
      logger.debug("deposit_checker_job - Processing TRX block: " + blockNum);
      TRX_DEPOSIT_QUEUE[blockNum] = child;

      //handle case of error
      child.on("error",function(err) {
        logger.error("deposit_checker_job - process returned error : "+ err);
        db.collection("trx_block").findOneAndUpdate({block:blockNum}, {$set: {status: "PENDING"}});
        TRX_DEPOSIT_QUEUE[blockNum].kill();
        delete TRX_DEPOSIT_QUEUE[blockNum];
      });
			
      //force kill process if stuck
      setTimeout(()=>{
        if (TRX_DEPOSIT_QUEUE[blockNum]){
          logger.info(`deposit_checker_job - force-killing block ${blockNum} due to inactivity`);
          TRX_DEPOSIT_QUEUE[blockNum].kill();
          delete TRX_DEPOSIT_QUEUE[blockNum];
          db.collection("trx_block").findOneAndUpdate({block:blockNum}, {$set: {status: "PENDING"}});
        }
      }, process.env.TRX_SCAN_TIMEOUT*1000);

      child.on("message", function(data) {
        logger.debug("deposit_checker_job - Received data from trx_deposit_process: " + data);
        const jsonD = JSON.parse(data);
        if(jsonD.block) {
          logger.info("deposit_checker_job - Killing child trx_deposit_process for " + jsonD.block);
          db.collection("trx_block").findOneAndUpdate(
            {block:jsonD.block}, 
            {$set: {status: jsonD.status}}
          );
          TRX_DEPOSIT_QUEUE[jsonD.block].kill();
          delete TRX_DEPOSIT_QUEUE[jsonD.block];
        }
      });
    } else {
      if(Object.keys(TRX_DEPOSIT_QUEUE).length === TRX_QUEUE_SIZE) {
        logger.warn("deposit_checker_job - Processing queue has been filled up");
        break;
      } else {
        logger.warn("deposit_checker_job - " +  blockNum + " is already being processed");
      }
    }
  }
};



// FIL Deposit Functions
// Nov 12 2020 (zhen) - added fil handling
const retrieveFilTxns = async(db) => {
  // queue up the blocks
  let fromBlk = (await dbUtil.getBaseItemValue(db, "lastBlkFil"));
  let toBlk = await filUtil.getLastBlockNum();
  if(fromBlk > toBlk) fromBlk = toBlk;	
  await db.collection("fil_block").remove({status:"DONE"});
	
  logger.debug("last block from db: "+ fromBlk + " from util: "+ toBlk);
  for(let blk = fromBlk; blk < toBlk; blk++) {
    await db.collection("fil_block").update({block: blk},{block:blk, status:"PENDING"}, {upsert:true});
  }
  logger.debug("deposit_checker_job - last block: " + toBlk);
  await db.collection("base").findOneAndUpdate({name:"lastBlkFil"}, {$set:{value: toBlk}});

  const blockList = await db.collection("fil_block").find({status:{$nin:["DONE","PROCESSING"]}}).sort({block:1}).toArray();
  for(const rec of blockList) {
    const blockNum = rec.block;
    if(Object.keys(FIL_DEPOSIT_QUEUE).length < FIL_QUEUE_SIZE && !FIL_DEPOSIT_QUEUE[blockNum]) {
      const child = cp.fork("app/processes/fil_deposit_process.js",[global.APP_HASH, global.SHARED_KEY,blockNum]);
      await db.collection("fil_block").findOneAndUpdate({block: blockNum}, {$set:{status:"PROCESSING"}});
      logger.debug("deposit_checker_job - Processing FIL block: " + blockNum);
      FIL_DEPOSIT_QUEUE[blockNum] = child;
      child.on("message", function(data) {
        logger.debug("deposit_checker_job - Received data from fil_deposit_process: " + data);
        const jsonD = JSON.parse(data);
        if(jsonD.block) {
          logger.info("deposit_checker_job - Killing child fil_deposit_process for " + jsonD.block);
          db.collection("fil_block").findOneAndUpdate(
            {block:jsonD.block}, 
            {$set: {status: jsonD.status}}
          );
          FIL_DEPOSIT_QUEUE[jsonD.block].kill();
          delete FIL_DEPOSIT_QUEUE[jsonD.block];
        }
      });
    } else {
      if(Object.keys(FIL_DEPOSIT_QUEUE).length === FIL_QUEUE_SIZE) {
        logger.warn("deposit_checker_job - Processing queue has been filled up");
        break;
      } else {
        logger.warn("deposit_checker_job - " +  blockNum + " is already being processed");
      }
    }
  }
};

const init = async(db) => {
  logger.info("INIT for deposit checker job called");
  await db.collection("trx_block").update({status:"PROCESSING"},{$set:{status:"PENDING"}},{multi: true});
  await db.collection("fil_block").update({status:"PROCESSING"},{$set:{status:"PENDING"}},{multi: true});
};

module.exports = {
  start: async (db) => {
    await init(db);
    let millisInterval = parseInt(process.env.DEPOSIT_INTERVAL) * 1000;
    logger.debug("Starting up deposit_checker_job. Interval: " + millisInterval);
    setInterval(depositChecker, millisInterval, db);
  },
  test: (db) => {
    return depositChecker(db);
  }
};
