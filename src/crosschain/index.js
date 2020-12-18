const axios = require('axios')
const {BufferParser} = require('../utils')
const CKB = require('@nervosnetwork/ckb-sdk-core').default;
const Web3 = require('web3')

const ETH_NODE_URL='https://ropsten.infura.io/v3/' //add your own api token
const FORCE_BRIDGER_SERVER_URL = 'http://local:1000' //update to your force server url
const NODE_URL = 'http://127.0.0.1:8114/' //update to your node url
const signEthPrivateKey = 'xxx' //update with your own private key
const USER_ETH_ADDR = '0xEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE' //update with your own eth addr

const web3 = new Web3(ETH_NODE_URL);
const ckb = new CKB(NODE_URL);
const ORDERBOOK_LOCK_CODEHASH = '0x279bee9fa98959029766c0e0ce19cd91b7180fd15b600a9e95140149b524c53b'
const ORDERBOOK_LOCK_TYPE = 'type'
const PW_LOCK_CODEHASH = '0x58c5f491aba6d61678b7cf7edf4910b1f5e00ec0cde2f42e0abb4fd9aff25a63'
const PW_LOCK_HASHTYPE = 'type'

const userPWEthLock = {
  codeHash: PW_LOCK_CODEHASH, 
  hashType: PW_LOCK_HASHTYPE, 
  args: USER_ETH_ADDR, 
};
const userPWEthLockHash = ckb.utils.scriptToHash(userPWEthLock);
console.log("userPWEthLockHash: ", userPWEthLockHash); 

const userEthCKBAddress = ckb.utils.fullPayloadToAddress({
  args: userPWEthLockHash,
  type: ORDERBOOK_LOCK_TYPE == "type" ? ckb.utils.AddressType.TypeCodeHash: ckb.utils.AddressType.DataCodeHash, 
  prefix: ckb.utils.AddressPrefix.Testnet,
  codeHash: ORDERBOOK_LOCK_CODEHASH,
})
console.log("userEthCKBAddress: ", userEthCKBAddress)

let recipientCKBAddress = userEthCKBAddress

const getOrCreateBridgeCell = async(
    recipientCkbAddress,
    ethTokenAddress,
    bridgeFee,
    retry = 0,
  ) => {
    try {
      const res = await axios.post(`${FORCE_BRIDGER_SERVER_URL}/get_or_create_bridge_cell`, {
        recipient_address: recipientCkbAddress,
        eth_token_address: ethTokenAddress,
        bridge_fee: bridgeFee,
      })
      return res
    } catch (error) {
      if (retry >= 5) {
        return Promise.resolve(Object.create({}))
      }
      // eslint-disable-next-line no-param-reassign
      retry += 1
      return getOrCreateBridgeCell(recipientCkbAddress, ethTokenAddress, bridgeFee, retry)
    }
  }

const placeCrossChainOrder = async(
  bridgeCells, udtDecimal,
  marketPrice, orderAmount, isBid,
  tokenAddress, 
  bridgeFee, 
    ) => {
    let ethAddress = USER_ETH_ADDR
    const gasPrice = await web3.eth.getGasPrice()
    const nonce = await web3.eth.getTransactionCount(ethAddress)
    console.log("gasPrice, nonce: ", gasPrice, nonce)

    const sudtRelatedData = sudtExtraData(marketPrice, orderAmount, isBid, udtDecimal);
    const amount = BufferParser.toHexString(sudtRelatedData.payAmount)
    let recipientAddress = recipientCKBAddress;
    let op = bridgeCells.shift();
    let sudtData = sudtRelatedData.orderData;

    const postData = {
        sender: ethAddress,
        token_address: tokenAddress,
        amount: BufferParser.toHexString(amount),
        bridge_fee: bridgeFee,
        ckb_recipient_address: recipientAddress,
        replay_resist_outpoint: op,
        sudt_extra_data: sudtData,
        gas_price: BufferParser.toHexString(gasPrice),
        nonce: BufferParser.toHexString(nonce),
        }
    console.log("lock postData: ",JSON.stringify(postData))
    const res = await axios.post(`${FORCE_BRIDGER_SERVER_URL}/lock`, postData)
    return res
}

const parseIntPOW4 = (number) => {
    return BigInt(parseInt(number * 10 ** 4));
}

const sudtExtraData = (marketPrice, orderAmount, isBid, decimal) => {
    console.log("marketPrice, orderAmount: ", marketPrice, orderAmount)
    let targetDecimal = BigInt(28) - decimal;

    let bidPrice = parseIntPOW4(marketPrice) * 10n ** targetDecimal / (10n**4n);
    let bidOrderAmount = parseIntPOW4(orderAmount) * 10n ** decimal/(10n**4n);
    let bidCKBAmount = parseIntPOW4(marketPrice) * parseIntPOW4(orderAmount) * 10n ** 8n/ 10n ** 8n; 
    let bidPayCKBAmount = bidCKBAmount + (bidCKBAmount * 3n / 1000n);

    let askPrice = parseIntPOW4(marketPrice) * 10n ** targetDecimal / (10n**4n);
    let askSUDTAmount = parseIntPOW4(orderAmount) * 10n ** decimal / (10n**4n); //doesn't include fee
    // the receive CKB amount for ask order
    let askOrderAmount = parseIntPOW4(orderAmount) * parseIntPOW4(marketPrice) * 10n ** 8n / (10n ** 8n) ;
    let askSUDTCurrentAmount = askSUDTAmount + (askSUDTAmount * 3n / 1000n); //include fee

    if (isBid) {
        return {payAmount: bidPayCKBAmount, orderData: formatOrderData(bidOrderAmount, bidPrice, true)};
    } else if(!isBid) {
        return {payAmount: askSUDTCurrentAmount, orderData: formatOrderData(askOrderAmount, askPrice, false)};
    } 
}

const formatOrderData = (orderAmount, price, isBid) => {
    const orderAmountHex = BufferParser.writeBigUInt128LE(orderAmount).replace('0x', '');

    const priceHex = BufferParser.writeBigUInt128LE(price).replace('0x', '');

    const bidOrAskBuf = Buffer.alloc(1);
    bidOrAskBuf.writeInt8(isBid ? 0 : 1);
    const isBidHex = `${bidOrAskBuf.toString('hex')}`;

    const dataHex = orderAmountHex + priceHex + isBidHex;
    return dataHex;
};

const signETHTX = (ethTX, privateKey) => {
    const tx = {...ethTX}
    // console.log("ethTX: ", tx)
    return web3.eth.accounts.signTransaction(tx, privateKey)
}

const sendETHTXAndRelay =(signTXPromise) => {
    let rawTX;
    let txHash;
    signTXPromise.then(res => {  
        rawTX = res.rawTransaction
        txHash = res.transactionHash
        const sentTx = web3.eth.sendSignedTransaction(rawTX);  
        sentTx.on("receipt", receipt => {
          console.log("send success！", receipt)
        relayEthToCKB(txHash).then(
            r => console.log("relayEthToCKB: ", r.data)
        )
        });
        sentTx.on("error", err => {
          console.log("send error：", err)
        });
      }).catch((err) => {
        console.log("something error happend: ", err)
      });
}

const relayEthToCKB =async(ethTXhash)=>{
    const postData = {eth_lock_tx_hash: ethTXhash}
    const res = await axios.post(`${FORCE_BRIDGER_SERVER_URL}/relay_eth_to_ckb_proof`, postData)
    return res
}

let ethTokenAddress = '0x0000000000000000000000000000000000000000'
let bridgeFee = '0x0'
let bridgeCells = [];
let udtDecimal = 18n;
let orderPrice = 12999.55;
let orderAmount = 0.005;
let isBid = false;
getOrCreateBridgeCell(recipientCKBAddress,ethTokenAddress,bridgeFee).then(
    r => {
        console.log(r.data.outpoints)
        bridgeCells=[...r.data.outpoints];
        placeCrossChainOrder(bridgeCells, udtDecimal, orderPrice, orderAmount, isBid, ethTokenAddress, bridgeFee).then(
            r => {
                lockRsp = r.data;
                const signedTX = signETHTX(lockRsp, signEthPrivateKey)
                sendETHTXAndRelay(signedTX)
        });
    }
)
