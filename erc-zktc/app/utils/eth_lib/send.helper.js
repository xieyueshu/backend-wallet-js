const EthereumTx = require("ethereumjs-tx");
const BigNumber = require("bignumber.js");
const Web3Accounts = require("web3-eth-accounts");

const logger = require("../../../config/winston-job.js");
const dbUtil = require("../db_utils");

const erc20 = require("./erc20_lib");
const web3Lib = require("./web3_lib");

const accounts = new Web3Accounts(process.env.NODE_ETH_NETWORK);
const DEFAULT_CONTRACT_DECIMAL = process.env.ETH_CONTRACT_DECIMAL || 8;
module.exports = {
  DEFAULT_CONTRACT_DECIMAL,

  async sendTransactionToWeb3(details, wallet, web3) {
    let rawTransaction = "";
    if(process.env.ETH_OTHER_CHAIN_SUPPORT === "Y") {
      const accFromKey = accounts.privateKeyToAccount(wallet.key);
      const signed = await accFromKey.signTransaction(details);
      rawTransaction = signed.rawTransaction;
    } else {
      const transaction = new EthereumTx(details);
      transaction.sign(Buffer.from(wallet.key.replace("0x",""), "hex"));
      const serializedTransaction = transaction.serialize();
      rawTransaction = "0x" + serializedTransaction.toString("hex");
    }
    return web3Lib.sendRawTransaction(web3, rawTransaction);
  },

  getSendDetails(wallet, amountToSend, web3) {
    let data, value, to;
    // check if the type of transaction will be AMTC or ETH
    if (wallet.type === "AMTC") {
      let contract = erc20.contract;
      data = this.getSendData(wallet, contract, amountToSend);
      value = "0x0";
      to = process.env.ETH_CONTRACT_ADDRESS;
    } else {
      // Sep 23 2020 (danie) - used bignumber instead of web3 tohex due to updating web3
      logger.debug("sendHelper - Creating an ETH transaction");
      data = "0x0";
      value = "0x" + (new BigNumber(web3.toWei(amountToSend, "ether")).toString(16));
      to = wallet.toAddress;
    }
    return { data, value, to };
  },

  async getWalletNonce(wallet, db, web3) {
    let nonce = 0;
    // if the nonce has been provided, we use it
    // otherwise, get the largest nonce 
    if (wallet.nonce) {
      nonce = wallet.nonce;
    } else {
      let dbNonce = await dbUtil.getMaxNonce(wallet.fromAddress, db);
      logger.debug("sendHelper - DB nonce : " + dbNonce);
      let webNonce = await web3Lib.getTxnCnt(web3, wallet.fromAddress);
      logger.debug("sendHelper - Web nonce: " + webNonce);

      if (dbNonce >= webNonce) {
        nonce = dbNonce + 1;
      } else {
        nonce = webNonce;
      }
    }
    logger.debug(`sendHelper - ${wallet.fromAddress} nonce:  ${nonce}`);
    return nonce;
  },

  getSendData(wallet, contract, amountToSend) {
    let data;
    if (wallet.use === "APPROVE") {
      logger.info("sendHelper - Creating an approve transaction");
      data = contract.approve.getData(wallet.toAddress, module.exports.getRawAmount(Number.MAX_SAFE_INTEGER).toString());
    } else {
      // transform the amount into the amount of tokens
      const contractAmt = this.getRawAmount(amountToSend, contract.decimals()).toNumber();
      // create the transfer data using the contract
      if (wallet.senderAddress) {
        logger.info("sendHelper - Creating an transferFrom transaction");
        data = contract.transferFrom.getData(wallet.senderAddress, wallet.toAddress, contractAmt);
      } else {
        logger.info("sendHelper - Creating an transfer transaction");
        data = contract.transfer.getData(wallet.toAddress, contractAmt, {
          from: wallet.fromAddress
        });
      }
    }
    return data;
  },

  getRawAmount (amount, decimals = DEFAULT_CONTRACT_DECIMAL) {
    return BigNumber(amount).times(BigNumber(10).pow(decimals));
  },
  
  doesntMeetMinimumToken(tokenAmount) {
    const tokenMin = new BigNumber(process.env.ETH_GAS_AMTC_MIN || "0");
    const hasEnoughTokens = tokenMin.gt(0) ? new BigNumber(tokenAmount).gte(tokenMin) : new BigNumber(tokenAmount).gt(tokenMin);
    return !hasEnoughTokens;
  },
};