module.exports = {
  getLatestBlock: (web3) => {
    return new Promise(
      function(resolve, reject) {
        web3.eth.getBlockNumber((err, res) => {
          if (err) reject(err);
          resolve(res);
        });
      }
    );
  },
  getBalance: (web3, address) => {
    return new Promise(
      function(resolve, reject) {
        web3.eth.getBalance(address, (err, res) => {
          if (err) reject(err);
          resolve(res);
        });
      }
    );
  },
  getBlock: (web3, blkNum, txnFlag = false) => {
    return new Promise(
      function(resolve, reject) {
        web3.eth.getBlock(blkNum, txnFlag, (err, res) => {
          if (err) reject(err);
          resolve(res);
        });
      }
    );
  },
  getTxnCnt: (web3, address) => {
    return new Promise(
      function(resolve, reject) {
        web3.eth.getTransactionCount(address, (err, res) => {
          if (err) reject(err);
          resolve(res);
        });
      }
    );
  },
  sendRawTransaction: (web3, signedTxn) => {
    return new Promise(
      function(resolve, reject) {
        web3.eth.sendRawTransaction(signedTxn, (err, res) => {
          if (err) reject(err);
          resolve(res);
        });
      }
    );
  },
  getReceipt: (web3, txnHash) => {
    return new Promise(
      function(resolve, reject) {
        web3.eth.getTransactionReceipt(txnHash, (err, res) => {
          if (err) reject(err);
          resolve(res);
        });
      }
    );
  },
  getTransaction: (web3, txnHash) => {
    return new Promise(
      function(resolve, reject) {
        web3.eth.getTransaction(txnHash, (err, res) => {
          if (err) reject(err);
          resolve(res);
        });
      }
    );
  }

};