/* eslint-disable */
const { fork } = require('child_process');
const assert = require('assert');
const BigNumber = require('bignumber.js');
const { Base64 } = require('js-base64');
const { MongoClient } = require('mongodb');

const { CONSTANTS } = require('../libs/Constants');
const { Database } = require('../libs/Database');
const blockchain = require('../plugins/Blockchain');
const { Transaction } = require('../libs/Transaction');
const { setupContractPayload } = require('../libs/util/contractUtil');


const conf = {
  chainId: "test-chain-id",
  genesisSteemBlock: 2000000,
  dataDirectory: "./test/data/",
  databaseFileName: "database.db",
  autosaveInterval: 0,
  javascriptVMTimeout: 10000,
  databaseURL: "mongodb://localhost:27017",
  databaseName: "testssc",
  streamNodes: ["https://api.steemit.com"],
};

let plugins = {};
let jobs = new Map();
let currentJobId = 0;
let database1 = null;

function send(pluginName, from, message) {
  const plugin = plugins[pluginName];
  const newMessage = {
    ...message,
    to: plugin.name,
    from,
    type: 'request',
  };
  currentJobId += 1;
  newMessage.jobId = currentJobId;
  plugin.cp.send(newMessage);
  return new Promise((resolve) => {
    jobs.set(currentJobId, {
      message: newMessage,
      resolve,
    });
  });
}


// function to route the IPC requests
const route = (message) => {
  const { to, type, jobId } = message;
  if (to) {
    if (to === 'MASTER') {
      if (type && type === 'request') {
        // do something
      } else if (type && type === 'response' && jobId) {
        const job = jobs.get(jobId);
        if (job && job.resolve) {
          const { resolve } = job;
          jobs.delete(jobId);
          resolve(message);
        }
      }
    } else if (type && type === 'broadcast') {
      plugins.forEach((plugin) => {
        plugin.cp.send(message);
      });
    } else if (plugins[to]) {
      plugins[to].cp.send(message);
    } else {
      console.error('ROUTING ERROR: ', message);
    }
  }
};

const loadPlugin = (newPlugin) => {
  const plugin = {};
  plugin.name = newPlugin.PLUGIN_NAME;
  plugin.cp = fork(newPlugin.PLUGIN_PATH, [], { silent: true });
  plugin.cp.on('message', msg => route(msg));
  plugin.cp.stdout.on('data', data => console.log(`[${newPlugin.PLUGIN_NAME}]`, data.toString()));
  plugin.cp.stderr.on('data', data => console.error(`[${newPlugin.PLUGIN_NAME}]`, data.toString()));

  plugins[newPlugin.PLUGIN_NAME] = plugin;

  return send(newPlugin.PLUGIN_NAME, 'MASTER', { action: 'init', payload: conf });
};

const unloadPlugin = (plugin) => {
  plugins[plugin.PLUGIN_NAME].cp.kill('SIGINT');
  plugins[plugin.PLUGIN_NAME] = null;
  jobs = new Map();
  currentJobId = 0;
}

const dummyParamsContractPayload = setupContractPayload('tokens', './contracts/testing/tokens_unused_params.js');
const contractPayload = setupContractPayload('tokens', './contracts/tokens.js');

async function assertNoErrorInLastBlock() {
  const transactions = (await database1.getLatestBlockInfo()).transactions;
  for (let i = 0; i < transactions.length; i++) {
    const logs = JSON.parse(transactions[i].logs);
    assert(!logs.errors, `Tx #${i} had unexpected error ${logs.errors}`);
  }
}

// tokens
describe('Tokens smart contract', function () {
  this.timeout(10000);

  before((done) => {
    new Promise(async (resolve) => {
      client = await MongoClient.connect(conf.databaseURL, { useNewUrlParser: true, useUnifiedTopology: true });
      db = await client.db(conf.databaseName);
      await db.dropDatabase();
      resolve();
    })
      .then(() => {
        done()
      })
  });
  
  after((done) => {
    new Promise(async (resolve) => {
      await client.close();
      resolve();
    })
      .then(() => {
        done()
      })
  });

  beforeEach((done) => {
    new Promise(async (resolve) => {
      db = await client.db(conf.databaseName);
      resolve();
    })
      .then(() => {
        done()
      })
  });

  afterEach((done) => {
      // runs after each test in this block
      new Promise(async (resolve) => {
        await db.dropDatabase()
        resolve();
      })
        .then(() => {
          done()
        })
  });

  it('creates a token', (done) => {
    new Promise(async (resolve) => {
      
      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1233', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, 'TXID1234', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'updateParams', '{ "tokenCreationFee": "200" }'));
      transactions.push(new Transaction(12345678901, 'TXID1235', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "200", "isSignedWithActiveKey": true }`));

      // should have to pay 200 BEE creation fee
      transactions.push(new Transaction(12345678901, 'TXID1236', 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKNTEST", "precision": 3, "maxSupply": "1000", "isSignedWithActiveKey": true  }'));

      // should not pay any creation fee because swap-eth is on the list of Hive Engine owned accounts
      transactions.push(new Transaction(12345678901, 'TXID1237', 'swap-eth', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "SWAP.KOIN", "precision": 3, "maxSupply": "1000", "isSignedWithActiveKey": true  }'));

      let block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });
      await assertNoErrorInLastBlock();

      let res = await database1.findOne({
          contract: 'tokens',
          table: 'tokens',
          query: {
            symbol: 'TKNTEST'
          }
        });

      let token = res;

      console.log(token);
      assert.equal(token.symbol, 'TKNTEST');
      assert.equal(token.issuer, 'harpagon');
      assert.equal(token.name, 'token');
      assert.equal(JSON.parse(token.metadata).url, 'https://token.com');
      assert.equal(token.maxSupply, 1000);
      assert.equal(token.supply, 0);

      res = await database1.findOne({
        contract: 'tokens',
        table: 'tokens',
        query: {
          symbol: 'SWAP.KOIN'
        }
      });

      token = res;

      console.log(token);
      assert.equal(token.symbol, 'SWAP.KOIN');
      assert.equal(token.issuer, 'swap-eth');
      assert.equal(token.name, 'token');
      assert.equal(JSON.parse(token.metadata).url, 'https://token.com');
      assert.equal(token.maxSupply, 1000);
      assert.equal(token.supply, 0);

      res = await database1.find({
        contract: 'tokens',
        table: 'balances',
        query: { "account": { "$in" : ["harpagon","swap-eth","null"] }}
      });

      console.log(res);
      assert.equal(res[0].symbol, `${CONSTANTS.UTILITY_TOKEN_SYMBOL}`);
      assert.equal(res[0].balance, '0.00000000');
      assert.equal(res[0].account, 'harpagon');
      assert.equal(res[1].symbol, `${CONSTANTS.UTILITY_TOKEN_SYMBOL}`);
      assert.equal(res[1].balance, '200.00000000');
      assert.equal(res[1].account, 'null');
      assert.equal(res.length, 2);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('generates error when trying to create a token with wrong parameters', (done) => {
    new Promise(async (resolve) => {
      
      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1233', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, 'TXID1233A', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'updateParams', '{ "tokenCreationFee": "100" }'));
      transactions.push(new Transaction(12345678901, 'TXID1234', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "99", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, 'TXID1234A', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "cryptomancer", "quantity": "100", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, 'TXID12341', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "T-KN", "precision": 3, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID12342', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKNNNNNNNNN", "precision": 3, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID12343', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN.TEST", "precision": 3.3, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID123445', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN.TEST", "precision": -1, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID12344', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN.TEST", "precision": 9, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID12345', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN.TEST", "precision": 8, "maxSupply": "-2", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID12346', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "&é", "symbol": "TKN.TEST", "precision": 8, "maxSupply": "-2", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID12347', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "qsdqsdqsdqsqsdqsdqsdqsdqsdsdqsdqsdqsdqsdqsdqsdqsdqsd", "symbol": "TKN.TEST", "precision": 8, "maxSupply": "-2", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID12348', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "abd", "symbol": ".TKN", "precision": 8, "maxSupply": "1", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID12349', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "abd", "symbol": "TKN.", "precision": 8, "maxSupply": "1", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID12350', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "abd", "symbol": "TN.THJ.HDG", "precision": 8, "maxSupply": "1", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID12351', 'cryptomancer', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "abd", "symbol": "SWAPKOIN", "precision": 8, "maxSupply": "1", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID12352', 'cryptomancer', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "abd", "symbol": "ETHKOIN", "precision": 8, "maxSupply": "1", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID12353', 'cryptomancer', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "abd", "symbol": "BSCKOIN", "precision": 8, "maxSupply": "1", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID12354', 'cryptomancer', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "abd", "symbol": "MY.KOIN", "precision": 8, "maxSupply": "1", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID12355', 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "abd", "symbol": "MYKOIN", "precision": 8, "maxSupply": "1", "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      const res = await database1.getBlockInfo(1);

      const block1 = res;
      const transactionsBlock1 = block1.transactions;

      console.log(JSON.parse(transactionsBlock1[4].logs).errors[0]);
      console.log(JSON.parse(transactionsBlock1[5].logs).errors[0]);
      console.log(JSON.parse(transactionsBlock1[6].logs).errors[0]);
      console.log(JSON.parse(transactionsBlock1[7].logs).errors[0]);
      console.log(JSON.parse(transactionsBlock1[8].logs).errors[0]);
      console.log(JSON.parse(transactionsBlock1[9].logs).errors[0]);
      console.log(JSON.parse(transactionsBlock1[10].logs).errors[0]);
      console.log(JSON.parse(transactionsBlock1[11].logs).errors[0]);
      console.log(JSON.parse(transactionsBlock1[12].logs).errors[0]);
      console.log(JSON.parse(transactionsBlock1[13].logs).errors[0]);
      console.log(JSON.parse(transactionsBlock1[14].logs).errors[0]);
      console.log(JSON.parse(transactionsBlock1[15].logs).errors[0]);
      console.log(JSON.parse(transactionsBlock1[16].logs).errors[0]);
      console.log(JSON.parse(transactionsBlock1[17].logs).errors[0]);
      console.log(JSON.parse(transactionsBlock1[18].logs).errors[0]);
      console.log(JSON.parse(transactionsBlock1[19].logs).errors[0]);

      assert.equal(JSON.parse(transactionsBlock1[4].logs).errors[0], 'invalid symbol: uppercase letters only and one "." allowed, max length of 10');
      assert.equal(JSON.parse(transactionsBlock1[5].logs).errors[0], 'invalid symbol: uppercase letters only and one "." allowed, max length of 10');
      assert.equal(JSON.parse(transactionsBlock1[6].logs).errors[0], 'invalid precision');
      assert.equal(JSON.parse(transactionsBlock1[7].logs).errors[0], 'invalid precision');
      assert.equal(JSON.parse(transactionsBlock1[8].logs).errors[0], 'invalid precision');
      assert.equal(JSON.parse(transactionsBlock1[9].logs).errors[0], 'maxSupply must be positive');
      assert.equal(JSON.parse(transactionsBlock1[10].logs).errors[0], 'invalid name: letters, numbers, whitespaces only, max length of 50');
      assert.equal(JSON.parse(transactionsBlock1[11].logs).errors[0], 'invalid name: letters, numbers, whitespaces only, max length of 50');
      assert.equal(JSON.parse(transactionsBlock1[12].logs).errors[0], 'invalid symbol: uppercase letters only and one "." allowed, max length of 10');
      assert.equal(JSON.parse(transactionsBlock1[13].logs).errors[0], 'invalid symbol: uppercase letters only and one "." allowed, max length of 10');
      assert.equal(JSON.parse(transactionsBlock1[14].logs).errors[0], 'invalid symbol: uppercase letters only and one "." allowed, max length of 10');
      assert.equal(JSON.parse(transactionsBlock1[15].logs).errors[0], 'invalid symbol: not allowed to use SWAP');
      assert.equal(JSON.parse(transactionsBlock1[16].logs).errors[0], 'invalid symbol: not allowed to use ETH');
      assert.equal(JSON.parse(transactionsBlock1[17].logs).errors[0], 'invalid symbol: not allowed to use BSC');
      assert.equal(JSON.parse(transactionsBlock1[18].logs).errors[0], 'invalid symbol: usage of "." is restricted');
      assert.equal(JSON.parse(transactionsBlock1[19].logs).errors[0], 'you must have enough tokens to cover the creation fees');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('updates contract params', (done) => {
    new Promise(async (resolve) => {

      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      // do a dummy test contract update that will add cancelBadUnstakes and fixMultiTxUnstakeBalance to params, so we can test that the real contract
      // update in the next transaction will remove both of these old, no-longer-used settings
      let transactions = [];
      transactions.push(new Transaction(30896501, 'TXID1233', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(dummyParamsContractPayload)));

      let block = {
        refHiveBlockNumber: 30896501,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });
      await assertNoErrorInLastBlock();

      let res = await database1.findOne({
        contract: 'tokens',
        table: 'params',
        query: {}
      });

      console.log(res);
      assert.equal(res.fixMultiTxUnstakeBalance, true);
      assert.equal(res.cancelBadUnstakes, true);
      assert.equal(res.blacklist, undefined);
      assert.equal(res.heAccounts, undefined);

      transactions = [];
      transactions.push(new Transaction(30896502, 'TXID1234', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(contractPayload)));

      block = {
        refHiveBlockNumber: 30896502,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });
      await assertNoErrorInLastBlock();

      res = await database1.findOne({
        contract: 'tokens',
        table: 'params',
        query: {}
      });

      assert.equal(res.fixMultiTxUnstakeBalance, undefined);
      assert.equal(res.cancelBadUnstakes, undefined);
      assert.equal(JSON.stringify(res.blacklist), '{"gateiodeposit":1,"deepcrypto8":1,"bittrex":1,"poloniex":1,"huobi-pro":1,"binance-hot":1,"bitvavo":1,"blocktrades":1,"probitsteem":1,"probithive":1,"ionomy":1,"mxchive":1,"coinbasebase":1,"orinoco":1,"user.dunamu":1}');
      assert.equal(JSON.stringify(res.heAccounts), '{"hive-engine":1,"swap-eth":1,"btc-swap":1,"graphene-swap":1,"honey-swap":1}');

      transactions = [];
      transactions.push(new Transaction(30896503, 'TXID1236', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'updateParams', '{ "tokenCreationFee": "123", "heAccounts": {"hive-engine":1,"lotsa-swap":1,"btc-swap":1,"graphene-swap":1,"honey-swap":1,"moartokens":1} }'));

      block = {
        refHiveBlockNumber: 30896503,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });
      await assertNoErrorInLastBlock();

      res = await database1.findOne({
        contract: 'tokens',
        table: 'params',
        query: {}
      });

      assert.equal(JSON.stringify(res.blacklist), '{"gateiodeposit":1,"deepcrypto8":1,"bittrex":1,"poloniex":1,"huobi-pro":1,"binance-hot":1,"bitvavo":1,"blocktrades":1,"probitsteem":1,"probithive":1,"ionomy":1,"mxchive":1,"coinbasebase":1,"orinoco":1,"user.dunamu":1}');
      assert.equal(JSON.stringify(res.heAccounts), '{"hive-engine":1,"lotsa-swap":1,"btc-swap":1,"graphene-swap":1,"honey-swap":1,"moartokens":1}');
      assert.equal(res.tokenCreationFee, '123');
      assert.equal(res.enableDelegationFee, '1000');
      assert.equal(res.enableStakingFee, '1000');

      transactions = [];
      transactions.push(new Transaction(30896504, 'TXID1237', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'updateParams', '{ "enableDelegationFee": "456", "enableStakingFee": "789" }'));

      block = {
        refHiveBlockNumber: 30896504,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });
      await assertNoErrorInLastBlock();

      res = await database1.findOne({
        contract: 'tokens',
        table: 'params',
        query: {}
      });

      assert.equal(res.tokenCreationFee, '123');
      assert.equal(res.enableDelegationFee, '456');
      assert.equal(res.enableStakingFee, '789');

      transactions = [];
      transactions.push(new Transaction(30896505, 'TXID1238', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'updateParams', '{ "blacklist": {"deepcrypto8":1,"bittrex":1,"poloniex":1,"huobi-pro":1,"binance-hot":1,"bitvavo":1,"blocktrades":1,"probitsteem":1,"probithive":1,"mxchive":1,"orinoco":1,"user.dunamu":1,"tester123":1} }'));

      block = {
        refHiveBlockNumber: 30896505,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });
      await assertNoErrorInLastBlock();

      res = await database1.findOne({
        contract: 'tokens',
        table: 'params',
        query: {}
      });

      assert.equal(JSON.stringify(res.blacklist), '{"deepcrypto8":1,"bittrex":1,"poloniex":1,"huobi-pro":1,"binance-hot":1,"bitvavo":1,"blocktrades":1,"probitsteem":1,"probithive":1,"mxchive":1,"orinoco":1,"user.dunamu":1,"tester123":1}');

      transactions = [];
      transactions.push(new Transaction(30896506, 'TXID1239', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'updateParams', '{ "blacklist": {"gateiodeposit":1,"deepcrypto8":1,"bittrex":1,"poloniex":1,"huobi-pro":1,"binance-hot":1,"bitvavo":1,"blocktrades":1,"probitsteem":1,"probithive":1,"mxchive":1,"orinoco":1,"user.dunamu":1,"tester123":1,"blahblah":1,"yoohoouser":1} }'));
      transactions.push(new Transaction(30896506, 'TXID1240', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'updateParams', '{ "heAccounts": {"hive-engine":1,"lotsa-swap":1,"btc-swap":1,"graphene-swap":1,"honey-swap":1,"moartokens":1,"yetmore":1} }'));

      block = {
        refHiveBlockNumber: 30896506,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });
      await assertNoErrorInLastBlock();

      res = await database1.findOne({
        contract: 'tokens',
        table: 'params',
        query: {}
      });

      console.log(res);
      assert.equal(JSON.stringify(res.blacklist), '{"gateiodeposit":1,"deepcrypto8":1,"bittrex":1,"poloniex":1,"huobi-pro":1,"binance-hot":1,"bitvavo":1,"blocktrades":1,"probitsteem":1,"probithive":1,"mxchive":1,"orinoco":1,"user.dunamu":1,"tester123":1,"blahblah":1,"yoohoouser":1}');
      assert.equal(JSON.stringify(res.heAccounts), '{"hive-engine":1,"lotsa-swap":1,"btc-swap":1,"graphene-swap":1,"honey-swap":1,"moartokens":1,"yetmore":1}');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('updates the url of a token', (done) => {
    new Promise(async (resolve) => {
      
      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1233', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(30896501, 'TXID1236', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'updateParams', '{ "tokenCreationFee": "0" }'));
      transactions.push(new Transaction(30896501, 'TXID1234', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN.TEST", "precision": 3, "maxSupply": "1000", "isSignedWithActiveKey": true  }'));

      let block = {
        refHiveBlockNumber: 30896501,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });
      await assertNoErrorInLastBlock();

      transactions = [];
      transactions.push(new Transaction(30896502, 'TXID1237', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'updateUrl', '{ "symbol": "TKN.TEST", "url": "https://new.token.com" }'));

      block = {
        refHiveBlockNumber: 30896502,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });
      await assertNoErrorInLastBlock();

      const res = await database1.findOne({
          contract: 'tokens',
          table: 'tokens',
          query: {
            symbol: 'TKN.TEST'
          }
        });

      const token = res;

      assert.equal(JSON.parse(token.metadata).url, 'https://new.token.com');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('does not update the url of a token', (done) => {
    new Promise(async (resolve) => {
      
      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1233', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(30896501, 'TXID1236', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'updateParams', '{ "tokenCreationFee": "0" }'));
      transactions.push(new Transaction(30896501, 'TXID1234', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN.TEST", "precision": 3, "maxSupply": "1000", "isSignedWithActiveKey": true  }'));

      let block = {
        refHiveBlockNumber: 30896501,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      transactions = [];
      transactions.push(new Transaction(30896502, 'TXID1237', 'satoshi', 'tokens', 'updateUrl', '{ "symbol": "TKN.TEST", "url": "https://new.token.com" }'));

      block = {
        refHiveBlockNumber: 30896502,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await database1.findOne({
          contract: 'tokens',
          table: 'tokens',
          query: {
            symbol: 'TKN.TEST'
          }
        });

      const token = res;

      assert.equal(JSON.parse(token.metadata).url, 'https://token.com');

      res = await database1.getBlockInfo(2);

      const block1 = res;
      const transactionsBlock1 = block1.transactions;

      assert.equal(JSON.parse(transactionsBlock1[0].logs).errors[0], 'must be the issuer');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('updates the metadata of a token', (done) => {
    new Promise(async (resolve) => {
      
      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1233', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(30896501, 'TXID1236', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'updateParams', '{ "tokenCreationFee": "0" }'));
      transactions.push(new Transaction(30896501, 'TXID1234', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN.TEST", "precision": 3, "maxSupply": "1000", "isSignedWithActiveKey": true  }'));

      let block = {
        refHiveBlockNumber: 30896501,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      transactions = [];
      transactions.push(new Transaction(30896502, 'TXID1237', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'updateMetadata', '{"symbol":"TKN.TEST", "metadata": { "url": "https://url.token.com", "image":"https://image.token.com"}}'));

      block = {
        refHiveBlockNumber: 30896502,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      const res = await database1.findOne({
          contract: 'tokens',
          table: 'tokens',
          query: {
            symbol: 'TKN.TEST'
          }
        });

      const token = res;

      const metadata = JSON.parse(token.metadata);
      assert.equal(metadata.url, 'https://url.token.com');
      assert.equal(metadata.image, 'https://image.token.com');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('transfers the ownership of a token', (done) => {
    new Promise(async (resolve) => {
      
      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1233', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(30896501, 'TXID1236', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'updateParams', '{ "tokenCreationFee": "0" }'));
      transactions.push(new Transaction(30896501, 'TXID1234', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN.TEST", "precision": 3, "maxSupply": "1000", "isSignedWithActiveKey": true  }'));

      let block = {
        refHiveBlockNumber: 30896501,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await database1.findOne({
          contract: 'tokens',
          table: 'tokens',
          query: {
            symbol: 'TKN.TEST'
          }
        });

      let token = res;

      assert.equal(token.issuer, CONSTANTS.HIVE_ENGINE_ACCOUNT);
      assert.equal(token.symbol, 'TKN.TEST');

      transactions = [];
      transactions.push(new Transaction(30896502, 'TXID1237', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transferOwnership', '{ "symbol":"TKN.TEST", "to": "satoshi", "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: 30896502,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      res = await database1.findOne({
          contract: 'tokens',
          table: 'tokens',
          query: {
            symbol: 'TKN.TEST'
          }
        });

      token = res;

      assert.equal(token.issuer, 'satoshi');
      assert.equal(token.symbol, 'TKN.TEST');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('does not transfer the ownership of a token', (done) => {
    new Promise(async (resolve) => {
      
      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1233', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(30896501, 'TXID1236', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'updateParams', '{ "tokenCreationFee": "0" }'));
      transactions.push(new Transaction(30896501, 'TXID1234', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN.TEST", "precision": 3, "maxSupply": "1000", "isSignedWithActiveKey": true  }'));

      let block = {
        refHiveBlockNumber: 30896501,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await database1.findOne({
          contract: 'tokens',
          table: 'tokens',
          query: {
            symbol: 'TKN.TEST'
          }
        });

      let token = res;

      assert.equal(token.issuer, CONSTANTS.HIVE_ENGINE_ACCOUNT);
      assert.equal(token.symbol, 'TKN.TEST');

      transactions = [];
      transactions.push(new Transaction(30896502, 'TXID1237', 'satoshi', 'tokens', 'transferOwnership', '{ "symbol":"TKN.TEST", "to": "satoshi", "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: 30896502,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      res = await database1.findOne({
          contract: 'tokens',
          table: 'tokens',
          query: {
            symbol: 'TKN.TEST'
          }
        });

      token = res;

      assert.equal(token.issuer, CONSTANTS.HIVE_ENGINE_ACCOUNT);
      assert.equal(token.symbol, 'TKN.TEST');

      res = await database1.getBlockInfo(2);

      const block1 = res;
      const transactionsBlock1 = block1.transactions;

      assert.equal(JSON.parse(transactionsBlock1[0].logs).errors[0], 'must be the issuer');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('issues tokens', (done) => {
    new Promise(async (resolve) => {
      
      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1233', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, 'TXID1234', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, 'TXID1235', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN.TEST", "precision": 0, "maxSupply": "1000" }'));
      transactions.push(new Transaction(12345678901, 'TXID1236', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'issue', '{ "symbol": "TKN.TEST", "quantity": "100", "to": "satoshi", "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      // check if the tokens have been accounted as supplied
      let res = await database1.findOne({
          contract: 'tokens',
          table: 'tokens',
          query: {
            symbol: "TKN.TEST"
          }
        });

      const token = res;

      assert.equal(token.supply, 100);

      // check if the "to" received the tokens
      res = await database1.findOne({
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: "TKN.TEST"
          }
        });

      const balance = res;

      assert.equal(balance.balance, 100);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('generates error when trying to issue tokens with wrong parameters', (done) => {
    new Promise(async (resolve) => {
      
      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1233', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, 'TXID1234', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, 'TXID1235', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN.TEST", "precision": 0, "maxSupply": "1000" }'));
      transactions.push(new Transaction(12345678901, 'TXID1236', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'issue', '{ "symbol": "TKN.TEST", "quantity": "100", "to": "satoshi" }'));
      transactions.push(new Transaction(12345678901, 'TXID1237', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'issue', '{ "symbol": "NTK", "quantity": "100", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1238', 'satoshi', 'tokens', 'issue', '{ "symbol": "TKN.TEST", "quantity": "100", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1239', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'issue', '{ "symbol": "TKN.TEST", "quantity": "100.1", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID12310', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'issue', '{ "symbol": "TKN.TEST", "quantity": "-100", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID12311', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'issue', '{ "symbol": "TKN.TEST", "quantity": "1001", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID12312', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'issue', '{ "symbol": "TKN.TEST", "quantity": "1000", "to": "az", "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      const res = await database1.getBlockInfo(1);

      const block1 = res;
      const transactionsBlock1 = block1.transactions;

      assert.equal(JSON.parse(transactionsBlock1[3].logs).errors[0], 'you must use a custom_json signed with your active key');
      assert.equal(JSON.parse(transactionsBlock1[4].logs).errors[0], 'symbol does not exist');
      assert.equal(JSON.parse(transactionsBlock1[5].logs).errors[0], 'not allowed to issue tokens');
      assert.equal(JSON.parse(transactionsBlock1[6].logs).errors[0], 'symbol precision mismatch');
      assert.equal(JSON.parse(transactionsBlock1[7].logs).errors[0], 'must issue positive quantity');
      assert.equal(JSON.parse(transactionsBlock1[8].logs).errors[0], 'quantity exceeds available supply');
      assert.equal(JSON.parse(transactionsBlock1[9].logs).errors[0], 'invalid to');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('transfers tokens', (done) => {
    new Promise(async (resolve) => {
      
      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1233', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, 'TXID1234', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, 'TXID1235', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN.TEST", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(12345678901, 'TXID1236', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'issue', '{ "symbol": "TKN.TEST", "quantity": "100", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1237', 'satoshi', 'tokens', 'transfer', '{ "symbol": "TKN.TEST", "quantity": "3e-8", "to": "vitalik", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1238', 'satoshi', 'tokens', 'transfer', '{ "symbol": "TKN.TEST", "quantity": "0.1", "to": "vitalik", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1239', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'create', `{ "isSignedWithActiveKey": true, "name": "token", "symbol": "NTK", "precision": 8, "maxSupply": "${Number.MAX_SAFE_INTEGER}" }`));
      transactions.push(new Transaction(12345678901, 'TXID12310', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'issue', `{ "symbol": "NTK", "quantity": "${Number.MAX_SAFE_INTEGER}", "to": "satoshi", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, 'TXID12311', 'satoshi', 'tokens', 'transfer', '{ "symbol": "NTK", "quantity": "0.00000001", "to": "vitalik", "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await database1.findOne({
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: "TKN.TEST"
          }
        });

      const balancesatoshi = res;

      assert.equal(balancesatoshi.balance, 99.89999997);

      res = await database1.findOne({
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'vitalik',
            symbol: "TKN.TEST"
          }
        });

      const balancevitalik = res;

      assert.equal(balancevitalik.balance, 0.10000003);

      res = await database1.findOne({
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: "NTK"
          }
        });

      const balNTKsatoshi = res;

      assert.equal(balNTKsatoshi.balance, BigNumber(Number.MAX_SAFE_INTEGER).minus("0.00000001").toFixed(8));

      res = await database1.findOne({
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'vitalik',
            symbol: "NTK"
          }
        });

      const balNTKvitalik = res;

      assert.equal(balNTKvitalik.balance, "0.00000001");

      // verify tokens can't be sent to a blacklisted account
      transactions = [];
      transactions.push(new Transaction(12345678902, 'TXID12312', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'issue', '{ "symbol": "TKN.TEST", "quantity": "100", "to": "cryptomancer", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678902, 'TXID12313', 'cryptomancer', 'tokens', 'transfer', '{ "symbol": "TKN.TEST", "quantity": "10", "to": "deepcrypto8", "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: 12345678902,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      res = await database1.findOne({
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'cryptomancer',
            symbol: "TKN.TEST"
          }
        });

      assert.equal(res.balance, 100);

      res = await database1.getBlockInfo(2);
      const block2 = res;
      const transactionsBlock2 = block2.transactions;

      assert.equal(JSON.parse(transactionsBlock2[1].logs).errors[0], 'not allowed to send to deepcrypto8');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('generates errors when trying to transfer tokens with wrong parameters', (done) => {
    new Promise(async (resolve) => {
      
      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1233', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, 'TXID1234', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, 'TXID1235', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN.TEST", "precision": 0, "maxSupply": "1000" }'));
      transactions.push(new Transaction(12345678901, 'TXID1236', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'issue', '{ "symbol": "TKN.TEST", "quantity": "100", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1237', 'satoshi', 'tokens', 'transfer', '{ "symbol": "TKN.TEST", "quantity": "7.99999999", "to": "vitalik" }'));
      transactions.push(new Transaction(12345678901, 'TXID1238', 'satoshi', 'tokens', 'transfer', '{ "symbol": "TKN.TEST", "quantity": "7.99999999", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1239', 'satoshi', 'tokens', 'transfer', '{ "symbol": "TKN.TEST", "quantity": "7.99999999", "to": "aa", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID12310', 'satoshi', 'tokens', 'transfer', '{ "symbol": "TNK", "quantity": "7.99999999", "to": "vitalik", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID12311', 'satoshi', 'tokens', 'transfer', '{ "symbol": "TKN.TEST", "quantity": "7.999999999", "to": "vitalik", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID123612', 'satoshi', 'tokens', 'transfer', '{ "symbol": "TKN.TEST", "quantity": "-1", "to": "vitalik", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID123613', 'vitalik', 'tokens', 'transfer', '{ "symbol": "TKN.TEST", "quantity": "101", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID123614', 'satoshi', 'tokens', 'transfer', '{ "symbol": "TKN.TEST", "quantity": "101", "to": "vitalik", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID123615', 'satoshi', 'tokens', 'transfer', '{ "symbol": "TKN.TEST", "quantity": "100", "to": "binance-hot", "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      const res = await database1.getBlockInfo(1);

      const block1 = res;
      const transactionsBlock1 = block1.transactions;

      console.log(JSON.parse(transactionsBlock1[4].logs).errors[0]);
      console.log(JSON.parse(transactionsBlock1[5].logs).errors[0]);
      console.log(JSON.parse(transactionsBlock1[6].logs).errors[0]);
      console.log(JSON.parse(transactionsBlock1[7].logs).errors[0]);
      console.log(JSON.parse(transactionsBlock1[8].logs).errors[0]);
      console.log(JSON.parse(transactionsBlock1[9].logs).errors[0]);
      console.log(JSON.parse(transactionsBlock1[10].logs).errors[0]);
      console.log(JSON.parse(transactionsBlock1[11].logs).errors[0]);
      console.log(JSON.parse(transactionsBlock1[12].logs).errors[0]);

      assert.equal(JSON.parse(transactionsBlock1[4].logs).errors[0], 'you must use a custom_json signed with your active key');
      assert.equal(JSON.parse(transactionsBlock1[5].logs).errors[0], 'cannot transfer to self');
      assert.equal(JSON.parse(transactionsBlock1[6].logs).errors[0], 'invalid to');
      assert.equal(JSON.parse(transactionsBlock1[7].logs).errors[0], 'symbol does not exist');
      assert.equal(JSON.parse(transactionsBlock1[8].logs).errors[0], 'symbol precision mismatch');
      assert.equal(JSON.parse(transactionsBlock1[9].logs).errors[0], 'must transfer positive quantity');
      assert.equal(JSON.parse(transactionsBlock1[10].logs).errors[0], 'balance does not exist');
      assert.equal(JSON.parse(transactionsBlock1[11].logs).errors[0], 'overdrawn balance');
      assert.equal(JSON.parse(transactionsBlock1[12].logs).errors[0], 'not allowed to send to binance-hot');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('transfers tokens to a contract', (done) => {
    new Promise(async (resolve) => {
      
      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      const testSmartContractCode = `
        actions.createSSC = function (payload) {
          // Initialize the smart contract via the create action
        }
      `;

      const testBase64SmartContractCode = Base64.encode(testSmartContractCode);

      const testContractPayload = {
        name: 'testcontract',
        params: '',
        code: testBase64SmartContractCode,
      };

      let transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1232', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, 'TXID1233', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(testContractPayload)));

      let block = {
        refHiveBlockNumber: 30896501,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      transactions = [];
      transactions.push(new Transaction(12345678902, 'TXID1234', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678902, 'TXID1235', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN.TEST", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(12345678902, 'TXID1236', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'issue', '{ "symbol": "TKN.TEST", "quantity": "100", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678902, 'TXID1237', 'satoshi', 'tokens', 'transferToContract', '{ "from": "aggroed", "symbol": "TKN.TEST", "quantity": "7.99999999", "to": "testcontract", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678902, 'TXID1238', 'null', 'tokens', 'transferToContract', '{ "from": "satoshi", "symbol": "TKN.TEST", "quantity": "1", "to": "testcontract", "isSignedWithActiveKey": false }'));

      block = {
        refHiveBlockNumber: 12345678902,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await database1.getBlockInfo(2);

      const block2 = res;
      const transactionsBlock2 = block2.transactions;

      console.log(transactionsBlock2[3].logs);
      console.log(transactionsBlock2[4].logs);

      res = await database1.findOne({
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: "TKN.TEST"
          }
        });

      const balancesatoshi = res;

      assert.equal(balancesatoshi.balance, 91.00000001);

      res = await database1.findOne({
          contract: 'tokens',
          table: 'contractsBalances',
          query: {
            account: 'testcontract',
            symbol: "TKN.TEST"
          }
        });

      const testcontract = res;

      assert.equal(testcontract.balance, 8.99999999);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('generates errors when trying to transfer tokens to a contract with wrong parameters', (done) => {
    new Promise(async (resolve) => {
      
      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1233', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, 'TXID1234', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, 'TXID1235', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN.TEST", "precision": 0, "maxSupply": "1000" }'));
      transactions.push(new Transaction(12345678901, 'TXID1236', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'issue', '{ "symbol": "TKN.TEST", "quantity": "100", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1237', 'satoshi', 'tokens', 'transferToContract', '{ "symbol": "TKN.TEST", "quantity": "7.99999999", "to": "testcontract" }'));
      transactions.push(new Transaction(12345678901, 'TXID1238', 'satoshi', 'tokens', 'transferToContract', '{ "symbol": "TKN.TEST", "quantity": "7.99999999", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1239', 'satoshi', 'tokens', 'transferToContract', '{ "symbol": "TKN.TEST", "quantity": "7.99999999", "to": "ah", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID12310', 'satoshi', 'tokens', 'transferToContract', '{ "symbol": "TNK", "quantity": "7.99999999", "to": "testcontract", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID12311', 'satoshi', 'tokens', 'transferToContract', '{ "symbol": "TKN.TEST", "quantity": "7.999999999", "to": "testcontract", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID12312', 'satoshi', 'tokens', 'transferToContract', '{ "symbol": "TKN.TEST", "quantity": "-1", "to": "testcontract", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID12313', 'vitalik', 'tokens', 'transferToContract', '{ "symbol": "TKN.TEST", "quantity": "101", "to": "testcontract", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID12314', 'null', 'tokens', 'transferToContract', '{ "from": "satoshi", "symbol": "TKN.TEST", "quantity": "101", "to": "testcontract", "isSignedWithActiveKey": false }'));
      transactions.push(new Transaction(12345678901, 'TXID12315', CONSTANTS.HIVE_PEGGED_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.HIVE_PEGGED_SYMBOL}", "quantity": "200", "to": "satoshi", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, 'TXID12316', 'satoshi', 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.HIVE_PEGGED_SYMBOL}", "quantity": "101", "to": "deepcrypto8", "isSignedWithActiveKey": true }`));

      let block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      const res = await database1.getBlockInfo(1);

      const block1 = res;
      const transactionsBlock1 = block1.transactions;

      assert.equal(JSON.parse(transactionsBlock1[4].logs).errors[0], 'you must use a custom_json signed with your active key');
      assert.equal(JSON.parse(transactionsBlock1[5].logs).errors[0], 'cannot transfer to self');
      assert.equal(JSON.parse(transactionsBlock1[6].logs).errors[0], 'invalid to');
      assert.equal(JSON.parse(transactionsBlock1[7].logs).errors[0], 'symbol does not exist');
      assert.equal(JSON.parse(transactionsBlock1[8].logs).errors[0], 'symbol precision mismatch');
      assert.equal(JSON.parse(transactionsBlock1[9].logs).errors[0], 'must transfer positive quantity');
      assert.equal(JSON.parse(transactionsBlock1[10].logs).errors[0], 'balance does not exist');
      assert.equal(JSON.parse(transactionsBlock1[11].logs).errors[0], 'overdrawn balance');
      assert.equal(JSON.parse(transactionsBlock1[13].logs).errors[0], 'not allowed to send to deepcrypto8');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('transfers tokens from a contract to a user', (done) => {
    new Promise(async (resolve) => {
      
      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      const smartContractCode = `
        actions.createSSC = function (payload) {
          // Initialize the smart contract via the create action
        }

        actions.sendRewards = async function (payload) {
          const { to, quantity } = payload;
          await api.transferTokens(to, 'TKN.TEST', quantity, 'user');
        }
      `;

      const base64SmartContractCode = Base64.encode(smartContractCode);

      const contractPayload = {
        name: 'testcontract',
        params: '',
        code: base64SmartContractCode,
      };

      let transactions = [];
      transactions.push(new Transaction(12345678902, 'TXID1233', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678902, 'TXID1232', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));

      let block = {
        refHiveBlockNumber: 12345678902,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      transactions = [];
      transactions.push(new Transaction(12345678903, 'TXID1234', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678903, 'TXID1235', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN.TEST", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(12345678903, 'TXID1236', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'issue', '{ "symbol": "TKN.TEST", "quantity": "100", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678903, 'TXID1237', 'satoshi', 'tokens', 'transferToContract', '{ "symbol": "TKN.TEST", "quantity": "7.99999999", "to": "testcontract", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678903, 'TXID1238', 'satoshi', 'testcontract', 'sendRewards', '{ "quantity": "5.99999999", "to": "vitalik", "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: 12345678903,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await database1.find({
          contract: 'tokens',
          table: 'balances',
          query: {
            account: { $in: ['satoshi', 'vitalik'] },
            symbol: "TKN.TEST"
          }
        });

      const balances = res;

      assert.equal(balances[0].balance, 92.00000001);
      assert.equal(balances[1].balance, 5.99999999);

      res = await database1.findOne({
          contract: 'tokens',
          table: 'contractsBalances',
          query: {
            account: 'testcontract',
            symbol: "TKN.TEST"
          }
        });

      const testcontract = res;

      assert.equal(testcontract.balance, 2);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('generates errors when trying to transfer tokens from a contract to a user with wrong parameters', (done) => {
    new Promise(async (resolve) => {
      
      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      const smartContractCode = `
        actions.createSSC = async function (payload) {
          // Initialize the smart contract via the create action
        }

        actions.notSigned = async function (payload) {
          await api.transferTokens('to', 'TKN.TEST', '2.02', 'user');
        }

        actions.toNotExist = async function (payload) {
          await api.transferTokens('df', 'TKN.TEST', '2.02', 'user');
        }

        actions.symbolNotExist = async function (payload) {
          await api.transferTokens('satoshi', 'TNK', '2.02', 'user');
        }

        actions.wrongPrecision = async function (payload) {
          await api.transferTokens('satoshi', 'TKN.TEST', '2.02', 'user');
        }

        actions.negativeQty = async function (payload) {
          await api.transferTokens('satoshi', 'TKN.TEST', '-2', 'user');
        }

        actions.balanceNotExist = async function (payload) {
          await api.transferTokens('satoshi', 'TKN.TEST', '2', 'user');
        }

        actions.overdrawnBalance = async function (payload) {
          await api.transferTokens('satoshi', 'TKN.TEST', '2', 'user');
        }
      `;

      const base64SmartContractCode = Base64.encode(smartContractCode);

      const contractPayload = {
        name: 'testcontract',
        params: '',
        code: base64SmartContractCode,
      };

      let transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1233', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, 'TXID1232', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, 'TXID1234', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, 'TXID1235', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN.TEST", "precision": 0, "maxSupply": "1000" }'));
      transactions.push(new Transaction(12345678901, 'TXID1236', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'issue', '{ "symbol": "TKN.TEST", "quantity": "100", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1237', 'satoshi', 'testcontract', 'notSigned', '{ }'));
      transactions.push(new Transaction(12345678901, 'TXID1238', 'satoshi', 'testcontract', 'toNotExist', '{ "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1239', 'satoshi', 'testcontract', 'symbolNotExist', '{ "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID12310', 'satoshi', 'testcontract', 'wrongPrecision', '{ "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID123611', 'satoshi', 'testcontract', 'negativeQty', '{ "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID123612', 'satoshi', 'testcontract', 'balanceNotExist', '{ "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID123713', 'satoshi', 'tokens', 'transferToContract', '{ "symbol": "TKN.TEST", "quantity": "1", "to": "testcontract", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID123614', 'satoshi', 'testcontract', 'overdrawnBalance', '{ "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      const res = await database1.getBlockInfo(1);

      const block1 = res;
      const transactionsBlock1 = block1.transactions;

      assert.equal(JSON.parse(transactionsBlock1[5].logs).errors[0], 'you must use a custom_json signed with your active key');
      assert.equal(JSON.parse(transactionsBlock1[6].logs).errors[0], 'invalid to');
      assert.equal(JSON.parse(transactionsBlock1[7].logs).errors[0], 'symbol does not exist');
      assert.equal(JSON.parse(transactionsBlock1[8].logs).errors[0], 'symbol precision mismatch');
      assert.equal(JSON.parse(transactionsBlock1[9].logs).errors[0], 'must transfer positive quantity');
      assert.equal(JSON.parse(transactionsBlock1[10].logs).errors[0], 'balance does not exist');
      assert.equal(JSON.parse(transactionsBlock1[12].logs).errors[0], 'overdrawn balance');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('transfers tokens from a contract to a contract', (done) => {
    new Promise(async (resolve) => {
      
      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      const smartContractCode = `
        actions.createSSC = function (payload) {
          // Initialize the smart contract via the create action
        }

        actions.sendRewards = async function (payload) {
          const { to, quantity } = payload;
          await api.transferTokens(to, 'TKN.TEST', quantity, 'contract');
        }
      `;

      const base64SmartContractCode = Base64.encode(smartContractCode);

      const contractPayload = {
        name: 'testcontract',
        params: '',
        code: base64SmartContractCode,
      };

      const smartContractCode2 = `
        actions.createSSC = function (payload) {
          // Initialize the smart contract via the create action
        }
      `;

      const base64SmartContractCode2 = Base64.encode(smartContractCode2);

      const contractPayload2 = {
        name: 'testcontract2',
        params: '',
        code: base64SmartContractCode2,
      };

      let transactions = [];
      transactions.push(new Transaction(12345678901, '123', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(30896501, 'TXID1232', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(30896501, 'TXID1233', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload2)));

      let block = {
        refHiveBlockNumber: 30896501,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      transactions = [];
      transactions.push(new Transaction(12345678902, 'TXID1234', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678902, 'TXID1235', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN.TEST", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(12345678902, 'TXID1236', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'issue', '{ "symbol": "TKN.TEST", "quantity": "100", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678902, 'TXID1237', 'satoshi', 'tokens', 'transferToContract', '{ "symbol": "TKN.TEST", "quantity": "7.99999999", "to": "testcontract", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678902, 'TXID1238', 'satoshi', 'testcontract', 'sendRewards', '{ "quantity": "5.99999999", "to": "testcontract2", "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: 12345678902,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await database1.find({
          contract: 'tokens',
          table: 'balances',
          query: {
            account: { $in: ['satoshi'] },
            symbol: "TKN.TEST"
          }
        });

      const balances = res;

      assert.equal(balances[0].balance, 92.00000001);

      res = await database1.find({
          contract: 'tokens',
          table: 'contractsBalances',
          query: {
            symbol: "TKN.TEST"
          }
        });

      const contractsBalances = res;

      assert.equal(contractsBalances[0].balance, 2);
      assert.equal(contractsBalances[1].balance, 5.99999999);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('generates errors when trying to transfer tokens from a contract to another contract with wrong parameters', (done) => {
    new Promise(async (resolve) => {
      
      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      const smartContractCode = `
        actions.createSSC = async function (payload) {
          // Initialize the smart contract via the create action
        }

        actions.notSigned = async function (payload) {
          await api.transferTokens('to', 'TKN.TEST', '2.02', 'contract');
        }

        actions.notToSelf = async function (payload) {
          await api.transferTokens('testcontract', 'TKN.TEST', '2.02', 'contract');
        }

        actions.toNotExist = async function (payload) {
          await api.transferTokens('sd', 'TKN.TEST', '2.02', 'contract');
        }

        actions.symbolNotExist = async function (payload) {
          await api.transferTokens('testcontract2', 'TNK', '2.02', 'contract');
        }

        actions.wrongPrecision = async function (payload) {
          await api.transferTokens('testcontract2', 'TKN.TEST', '2.02', 'contract');
        }

        actions.negativeQty = async function (payload) {
          await api.transferTokens('testcontract2', 'TKN.TEST', '-2', 'contract');
        }

        actions.balanceNotExist = async function (payload) {
          await api.transferTokens('testcontract2', 'TKN.TEST', '2', 'contract');
        }

        actions.overdrawnBalance = async function (payload) {
          await api.transferTokens('testcontract2', 'TKN.TEST', '2', 'contract');
        }

        actions.invalidParams = async function (payload) {
          await api.transferTokens('testcontract2', 'TKN.TEST', '2', 'invalid');
        }
      `;

      const base64SmartContractCode = Base64.encode(smartContractCode);

      const contractPayload = {
        name: 'testcontract',
        params: '',
        code: base64SmartContractCode,
      };

      const smartContractCode2 = `
        actions.createSSC = function (payload) {
          // Initialize the smart contract via the create action
        }
      `;

      const base64SmartContractCode2 = Base64.encode(smartContractCode2);

      const contractPayload2 = {
        name: 'testcontract2',
        params: '',
        code: base64SmartContractCode2,
      };

      let transactions = [];
      transactions.push(new Transaction(12345678901, '456', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, 'TXID1232', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, 'TXID1233', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload2)));
      transactions.push(new Transaction(12345678901, 'TXID1234', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, 'TXID1235', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN.TEST", "precision": 0, "maxSupply": "1000" }'));
      transactions.push(new Transaction(12345678901, 'TXID1236', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'issue', '{ "symbol": "TKN.TEST", "quantity": "100", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1237', 'satoshi', 'testcontract', 'notSigned', '{ }'));
      transactions.push(new Transaction(12345678901, 'TXID1238', 'satoshi', 'testcontract', 'notToSelf', '{ "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1239', 'satoshi', 'testcontract', 'toNotExist', '{ "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID123610', 'satoshi', 'testcontract', 'symbolNotExist', '{ "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID123611', 'satoshi', 'testcontract', 'wrongPrecision', '{ "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID123612', 'satoshi', 'testcontract', 'negativeQty', '{ "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID123613', 'satoshi', 'testcontract', 'balanceNotExist', '{ "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID123714', 'satoshi', 'tokens', 'transferToContract', '{ "symbol": "TKN.TEST", "quantity": "1", "to": "testcontract", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID123615', 'satoshi', 'testcontract', 'overdrawnBalance', '{ "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID123616', 'satoshi', 'testcontract', 'invalidParams', '{ "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      const res = await database1.getBlockInfo(1);

      const block1 = res;
      const transactionsBlock1 = block1.transactions;

      assert.equal(JSON.parse(transactionsBlock1[6].logs).errors[0], 'you must use a custom_json signed with your active key');
      assert.equal(JSON.parse(transactionsBlock1[7].logs).errors[0], 'cannot transfer to self');
      assert.equal(JSON.parse(transactionsBlock1[8].logs).errors[0], 'invalid to');
      assert.equal(JSON.parse(transactionsBlock1[9].logs).errors[0], 'symbol does not exist');
      assert.equal(JSON.parse(transactionsBlock1[10].logs).errors[0], 'symbol precision mismatch');
      assert.equal(JSON.parse(transactionsBlock1[11].logs).errors[0], 'must transfer positive quantity');
      assert.equal(JSON.parse(transactionsBlock1[12].logs).errors[0], 'balance does not exist');
      assert.equal(JSON.parse(transactionsBlock1[14].logs).errors[0], 'overdrawn balance');
      assert.equal(JSON.parse(transactionsBlock1[15].logs).errors[0], 'invalid params');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });
});
