// Sep 8 2020 (danie) - refactored withdraw creation 
var bitcoin = require("bitcoinjs-lib");
var Client = require("bitcoin-core");

const BigNumber = require("bignumber.js");
const btcTxn = require("./btc_lib/btc_send");
const logger = require("../../config/winston");
const secUtils = require("./security_utils");
const dbUtil = require("./db_utils");

const network = process.env.NODE_ENV === "production" ? bitcoin.networks.bitcoin : bitcoin.networks.testnet;

const getClient = () => {
  return new Client({
    host: process.env.BTC_RPC_HOST,
    username: process.env.BTC_RPC_USER,
    password: process.env.BTC_RPC_PASS,
    port: process.env.BTC_RPC_PORT || 8332
  });
};

const saveVout = async (db, txn) => {
  const vout = txn.vout.map(out => {
    return {
      value: out.value,
      n: out.n,
      addresses: out.scriptPubKey.addresses || null
    };
  }).sort((a, b) => a.n > b.n);
  const record = { txnHash: txn.txid, vout };
  const indexDb = await db.collection("btc_txn_index").findOne({txnHash: txn.txid}); 
  if(!indexDb) {
    await db.collection("btc_txn_index").insert(record);
  }
  return record;
};

module.exports = {
  /**
	 * Sends BTC from an address to another
	 */
  sendBtc: async (db, wallet, callback, willAdd = true) => {
    let out = [];
    if (wallet.multi) {
      out = wallet.inputs;
      logger.debug(`btc_utils.sendBtc - Sending from ${wallet.fromAddress} to ${JSON.stringify(out)}`);
    } else {
      logger.debug(`btc_utils.sendBtc - Sending ${wallet.amount} from ${wallet.fromAddress} to ${wallet.toAddress}`);
      out.push({
        address: wallet.toAddress,
        amount: BigNumber(wallet.amount).toNumber(),
        rate: 1
      });
    }
    const fee = await dbUtil.getGasPrice(db, "btc");		
    const allbalance = !wallet.amount && !wallet.notAllBalance;
    const fromBalance = allbalance ? await module.exports.getBalance(wallet.fromAddress) : 0;
    const hash = await btcTxn.sendTransaction({
      fee,
      allbalance,
      from: wallet.fromAddress,
      privKeyWIF: wallet.key,
      multi: true,
      to: out,
      minConfirmations: parseInt(process.env.BTC_CONFIRMATION_COUNT),
      network: process.env.NODE_ENV === "production" ? "bitcoin" : "testnet",
    });
    const transactionId = hash.data ? hash.data.txid : hash;
		
    logger.debug("btc_utils.sendBtc - Generating raw transaction...");
    let template = {
      status: "P",
      coinType: wallet.type,
      txnType: wallet.use,
      sender: wallet.fromAddress,
      recepient: wallet.toAddress,
      amount: allbalance ? fromBalance : wallet.amount,
      txnHash: transactionId,
      timeStamp: 0,
      trace: wallet.trace,
      createTime: new Date()
    };

    let txnDetails = [];
    if (wallet.multi) {
      for (let i = 0; i < wallet.inputs.length; i++) {
        let input = wallet.inputs[i];
        let txn = Object.assign({}, template);
        txn.amount = input.amount;
        txn.recepient = input.address;
        txn.trace = input.trace;
        txn.index = i;
        txn.indexHash = transactionId + `[${i}]`;
        txnDetails.push(txn);
      }
    } else {
      txnDetails.push(template);
    }

    if (willAdd) {
      try {
        await db.collection("transaction").insertMany(txnDetails);
        logger.info("btc_utils.sendBtc - Inserted transaction: " + transactionId);
      } catch (err) {
        logger.error("btc_utils.sendBtc - error occurred inserting transaction into database");
      }
    }

    return txnDetails;
  },
  forwardDeposit: async (db, addrRecord) => {
    let list = await dbUtil.getDepositList(db, "btc");
    if (!list) {
      list = [{
        address: process.env.BTC_COLD_WALLET,
        rate: 1
      }];
    }
    const txn = await btcTxn.sendTransaction({
      from: addrRecord.address,
      privKeyWIF: addrRecord.private,
      allbalance: true,
      multi: true,
      to: list,
      network: process.env.NODE_ENV === "production" ? "bitcoin" : "testnet",
      minConfirmations: parseInt(process.env.BTC_CONFIRMATION_COUNT)
    });
    const transactionId = txn.data.txid;

    let template = {
      status: "P",
      coinType: "BTC",
      txnType: "T",
      sender: addrRecord.address,
      txnHash: transactionId,
      timeStamp: 0,
      createTime: new Date()
    };
    let txnDetails = [];
    for (let i = 0; i < list.length; i++) {
      for (let i = 0; i < list.length; i++) {
        let input = list[i];
        let txn = Object.assign({}, template);
        txn.recepient = input.address;
        txn.index = i;
        txn.indexHash = transactionId + `[${i}]`;
        txnDetails.push(txn);
      }
    }
    await db.collection("transaction").insertMany(txnDetails);
  },
  getBalance: (address) => {
    let options = {
      network: process.env.NODE_ENV === "production" ? "bitcoin" : "testnet"
    };
    return btcTxn.getBalance(address, options);
  },
  getFees: async (db, txn) => {
    const txIdList = txn.vin.map(v => v.txid);
    let voutIn = await db.collection("btc_txn_index").find({ txnHash: { $in: txIdList } }).toArray();
    if(!voutIn || voutIn.length < txIdList.length) {
      const client = getClient();
      for (const txn of txIdList) {
        if(voutIn.length > 0 && voutIn.filter(v=>v.txnHash === txn)[0]) continue;
        const inTxn = await client.getRawTransaction(txn, 1);
        const vout = await saveVout(db, inTxn);
        if(!voutIn) voutIn = [];
        voutIn.push(vout);
      }
    }
    const vin = txn.vin;
    let totalIn = vin.reduce((total, vin) => {
      const amount = voutIn.filter(v=>vin.txid === v.txnHash)[0].vout[vin.vout].value;
      return total + amount;
    }, 0);
    let totalOut = txn.vout.reduce((total, vout) => total + vout.value, 0);
    await saveVout(db, txn);
    return totalIn - totalOut;
  },
  getLastBlock: async () => {
    const client = getClient();
    let resp = await client.command("getblockchaininfo");
    return resp.headers;
  },
  // Oct 9 2020 (danie) - changed from list of hash to object with hash as key and block details as the value
  getBlockTxns: async (start, end, detail = false) => {
    const client = getClient();
    let txnHashList = {};
    // exclude first since it was checked in the previous run
    for (var i = start + 1; i <= end; i++) {
      let blockHash = await client.command("getblockhash", i);
      let block = await client.getBlock(blockHash);
      let txns = block.tx;
      if (detail) {
        for (const j in txns) {
          // get the complete raw transaction details
          txns[j] = await client.getRawTransaction(txns[j], 1);
        }
      }
      for(const t of txns) txnHashList[t] = { blockHash, height: i };
    }
    logger.debug("btc_utils.getBlockTxns - Found " + Object.keys(txnHashList).length + "BTC transactions");
    return txnHashList;
  },
  getBlock: (hash) => {
    const client = getClient();
    return client.getBlock(hash);
  },
  getTxn: async (hash) => {
    const client = getClient();
    const rawTxn = await client.getRawTransaction(hash, 1);
    if (rawTxn.blockhash) {
      const block = await client.getBlock(rawTxn.blockhash);
      rawTxn.height = block.height;
    }
    return rawTxn;
  },
  // Oct 9 2020 (danie) - added function to retrieve transaction with block hash
  getTxnWithBlock: async (hash, block, height) => {
    const client = getClient();
    const rawTxn = await client.getRawTransaction(hash, 1, block);
    rawTxn.height = height;
    return rawTxn;
  },
  getTxnSender: async (txn) => {
    const client = getClient();
    let senders = [];
    for (let cnt = 0; cnt < txn.vin.length; cnt++) {
      let vin = txn.vin[cnt];
      try {
        if (vin.txid) {
          let inTxn = await client.getRawTransaction(vin.txid, 1);
          let out = inTxn.vout[vin.vout].scriptPubKey.addresses;
          senders = senders.concat(out);
        }
      } catch (err) {
        logger.warn("btc_utils.getBtcSender - error while getting sender: " + err.stack);
      }
    }
    // filter out any undefined elements (from repeated vouts)
    senders = senders.filter(sender => sender !== undefined);
    // convert to set to remove repeated values and back to an array 
    senders = Array.from(new Set(senders));
    if (senders.length === 1) return senders[0];
    else return senders.toString();
  },
  isAddress: async(address) => {
    const client = getClient();
    const res = await client.command("validateaddress", address);
    return res.isvalid && res.address === address;
  },
  // Aug 26 2020 (Danie) - added creation of withdraw request
  createBtcWithdrawRequest: async (withdraw, db, after) => {
    try {
      const coinType = withdraw.type.toUpperCase();
      logger.debug("btc_utils.createBtcWithdrawRequest - Create BTC withdraw request");
      const hotAddress = await module.exports.getBtcWithdrawWallet(coinType, db);
      const processed = await dbUtil.processWithdrawRequestList(db, module.exports, after, withdraw.request);
      if(!processed) return;
      const { transactions, totals } = processed;
      // oct 26 2020 (danie) - added totalAmount as param
      const approvedStatus = await dbUtil.getWithdrawApprovalStatus(withdraw, coinType, totals.totalAmount.toString());
      let withdrawRequest = {
        transactions,
        coinType,
        approvedStatus,
        sentAmount: false,
        createDt: new Date(),
        hotAddress: hotAddress.address,
        totalAmount: totals.totalAmount.toString(),
      };
      const record = await db.collection("withdraw_request").insertOne(withdrawRequest);
      const requestDetails = {
        requestId: record.ops[0]._id,
        address: withdrawRequest.hotAddress,
        totalAmount: totals.totalAmount.toString()
      };
      after(requestDetails);
      logger.debug("btc_utils.createBtcWithdrawRequest - inserted request: " + JSON.stringify(requestDetails));
    } catch (err) {
      logger.error("btc_utils.createBtcWithdrawRequest - " + err.stack);
      after({
        error: "An error occurred while processing the request"
      });
    }
  },
  hasFundsForTransfer: async(address, amount) => {
    let required = new BigNumber(amount);
    if (!amount) {
      required = new BigNumber(process.env.BTC_FEE_MIN);
    }
    const totalUnspent = await btcTxn.getBalance(address);
    return required.lte(totalUnspent);
  },
  /**
	 * Creates a BTC wallet to store into the database.
	 * Returns the address to the client.
	 * Aug 28 2020 (danie) - fixed creation of btc wallet
	 */
  createBtcWallet: async (res, db, walletType = "BTC") => {
    let params = { network };
    let keyPair = bitcoin.ECPair.makeRandom(params);
    const { address } = bitcoin.payments.p2pkh({ pubkey: keyPair.publicKey, network });
    let addressRec = {
      type: walletType,
      use: "D",
      address: address,
      publicKey: keyPair.publicKey.toString("base64"),
      private: secUtils.encryptKey(keyPair.toWIF())
    };
    logger.info("BTC Address generated: " + address);
    if(process.env.BTC_INSIGHT_SUPPORT === "N") {
      const client = getClient();
      await client.command("importaddress", address, "", false);
      logger.debug("btc_utils.createBtcWallet - imported address " + address);
    }
    db.collection("address").insert(addressRec, (err) => {
      if (err) {
        logger.error(err.stack);
        res.send({
          "error": "An error has occurred"
        });
      } else {
        // remove unneeded fields before returning to the user
        delete addressRec._id;
        delete addressRec.use;
        delete addressRec.private;
        delete addressRec.publicKey;
        logger.info("Sending to client: " + JSON.stringify(addressRec));
        res.send(addressRec);
      }
    });
  },
  checkRequest: async (db, request) => {
    // check if the amount being sent is equal to zero or negative
    if (new BigNumber(request.amount).lte(new BigNumber(0))) {
      return { error: "Negative or zero amounts are not allowed" };
    }
    if (!(await module.exports.isAddress(request.address))) {
      return { error: "Address supplied is not a valid address: " + request.address };
    }
    let hasTrace = await dbUtil.hasSameTrace(db, request.trace);
    if (hasTrace) {
      return { error: "Trace exists in database: " + request.trace };
    }
    return null;
  },
  getBtcWithdrawWallet: async (type, db) => {
    var hotAddress;
    if (process.env.USES_BIND_WALLET_WD === "Y") {
      // get the wallet details from the config file if withdrawals are from a single wallet
      hotAddress = {
        address: process.env.BTC_HOT_WALLET,
        key: process.env.BTC_HOT_WALLET_SECRET,
        type
      };
      logger.debug("Using hot wallet for withdraw request " + process.env.BTC_HOT_WALLET);
    } else {
      // generate the wallet and store it into the database
      let keyPair = bitcoin.ECPair.makeRandom();
      const { address } = bitcoin.payments.p2pkh({ pubkey: keyPair.publicKey });
			
      hotAddress = {
        address,
        key: keyPair.toWIF(),
        type
      };
	
      let wallet = {
        address,
        type,
        use: "W",
        private: secUtils.encryptKey(keyPair.privkey)
      };
      await db.collection("address").insert(wallet);
      logger.info("BTC address generated: " + wallet.address);
    }
    return hotAddress;
  },
};

// Aug 26 2020 (danie) - added withdraw3 helpers
// Withdraw helpers

