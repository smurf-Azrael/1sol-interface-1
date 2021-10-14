import { Button, Card, Spin, Skeleton, Popover, Modal } from "antd";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  LoadingOutlined,
  PlusOutlined ,
  RightOutlined,
  ArrowRightOutlined,
  SettingOutlined,
  ReloadOutlined,
  ExpandOutlined,
  CloseCircleOutlined
} from "@ant-design/icons";
import axios from 'axios'
import classNames from "classnames";

import {
  useConnection,
  useConnectionConfig,
  useSlippageConfig,
} from "../../utils/connection";
import { useWallet } from "../../context/wallet";
import { CurrencyInput } from "../currencyInput";
import { QuoteCurrencyInput } from "../quoteCurrencyInput";

import {
  PoolOperation,
  onesolProtocolSwap,
  createTokenAccount,
} from "../../utils/pools";
import { notify } from "../../utils/notifications";
import { useCurrencyPairState } from "../../utils/currencyPair";
import { generateActionLabel, POOL_NOT_AVAILABLE, SWAP_LABEL } from "../labels";
import { getTokenName } from "../../utils/utils";
import { Settings } from "../settings";

import { TokenIcon } from "../tokenIcon";

import { cache, useUserAccounts } from "../../utils/accounts";

import { PROVIDER_MAP } from "../../utils/constant";

import { AmmInfo } from "../../utils/onesol-protocol";

import { WRAPPED_SOL_MINT } from "../../utils/ids";

import "./trade.less";
import { PublicKey } from "@solana/web3.js";

const antIcon = <LoadingOutlined style={{ fontSize: 24 }} spin />;

interface Distribution {
  id: string,
  output: number, 
  routes: any[],
  provider: string,
  offset?: number,
}

interface Route {
  from: string,
  to: string,
  in: number,
  out: number,
  provider: string,
  ratio: number
}

export const TradeEntry = () => {
  const { wallet, connect, connected } = useWallet();
  const connection = useConnection();
  const [pendingTx, setPendingTx] = useState(false);
  const {
    A,
    B,
    setLastTypedAccount,
    setPoolOperation,
  } = useCurrencyPairState();

  const refreshBtnRef: {current: any} = useRef()

  const [loading, setLoading] = useState(false)
  const [timeoutLoading, setTimeoutLoading] = useState(false)
  
  // const [choice, setChoice] = useState('')
  // best swap routes
  const [amounts, setAmounts] = useState<Route[][]>([])
  const [distributions, setDistributions] = useState<Distribution[]>([])
  const [showRoute, setShowRoute] = useState(false)
  const [showShare, setShowShare] = useState(false)
  const [routeLabel, setRouteLable] = useState<string[]>([])

  const { slippage } = useSlippageConfig();
  const { tokenMap, chainId, ammInfos } = useConnectionConfig();

  const CancelToken = axios.CancelToken;
  const cancel = useRef(function () {})

  const timer: { current: NodeJS.Timeout | null } = useRef(null)
  const choice: {current: string} = useRef('')

  const [hasTokenAccount, setHasTokenAccount] = useState(false)

  const { userAccounts } = useUserAccounts();

  useEffect(() => {
    const getTokenAccount = (mint: string) => {
      // if B is SOL
      if (mint === WRAPPED_SOL_MINT.toBase58()) {
        return false
      }

      const index = userAccounts.findIndex(
        (acc: any) => acc.info.mint.toBase58() === mint
      );

      if (index !== -1) {
        return userAccounts[index];
      }

      return;
    }
    
    setHasTokenAccount(false)

    const tokenMint = cache.getMint(B.mintAddress);
    const tokenAccount = getTokenAccount(B.mintAddress);

    if (connected && tokenAccount && tokenMint) {
      setHasTokenAccount(true)
    }
  }, [connected, B.mintAddress, userAccounts])

  const fetchDistrubition = useCallback(async () => {
    if (!A.mint || !B.mint) {
      setLoading(false)
      setTimeoutLoading(false)

      return
    }

    // if (cancel.current) {
    //   cancel.current()
    // }

    // if (timer.current) {
    //   clearTimeout(timer.current)
    // }

    setLoading(true)
    setTimeoutLoading(false)

    const decimals = [A.mint.decimals, B.mint.decimals]
    // const providers = []

    // if (pool) {
    //   providers.push(pool.address)
    // }

    // if (market) {
    //   providers.push(market.address)
    // }

    try {
      const {
        data: {
          best, 
          distributions
        }
      }: {
        data: {
          best: {
            amount_out: number, 
            exchanger_flag: string, 
            routes: any[]
          } | undefined, 
          distributions: any
        }
      } = await axios({
        url: `https://api.1sol.io/1/swap/1/${chainId}`,
        method: 'post', 
        data: {
          amount_in: Number(A.amount) * 10 ** A.mint.decimals,
          source_token_mint_key: A.mintAddress,
          destination_token_mint_key: B.mintAddress, 
          programs: [
            "SwaPpA9LAaLfeLi3a68M4DjnLqgtticKg6CnyNwgAC8",
            "DESVgJVGajEgKGXhb6XmqDHGz3VjdgP7rEVESBgxmroY"
          ]
        }, 
        cancelToken: new CancelToken((c) => cancel.current = c)
      })

      let amounts: Route[][] = []
      let result: Distribution[] = []

      if (best) {
        const id = best.routes.flat(2).reduce((acc, cur) =>  `${acc}-${cur.pubkey}`, best.exchanger_flag)

        result.push({
          ...best,
          output: best.amount_out / 10 ** decimals[1], 
          provider: PROVIDER_MAP[best.exchanger_flag],
          offset: 0,
          id
        })

        // swap routes
        amounts = best.routes.map((routes: any) => routes.map(({
          amount_in,
          amount_out,
          exchanger_flag,
          source_token_mint,
          destination_token_mint
        }: {
          amount_in: number, 
          amount_out: number, 
          exchanger_flag: string, 
          source_token_mint: { pubkey: string, decimals: number }
          destination_token_mint: { pubkey: string, decimals: number }
        }) => ({
            from: tokenMap.get(source_token_mint.pubkey)?.symbol,
            to: tokenMap.get(destination_token_mint.pubkey)?.symbol,
            in: amount_in / 10 ** source_token_mint.decimals,
            out: amount_out / 10 ** destination_token_mint.decimals,
            provider: PROVIDER_MAP[exchanger_flag],
            ratio: (amount_in / 10 ** source_token_mint.decimals) / routes.reduce((acc: number, cur: any) => acc + cur.amount_in / 10 ** source_token_mint.decimals , 0) * 100
          }
        )))
      }

      result = [...result, 
        ...distributions
        .sort((a: any, b: any) => b.amount_out - a.amount_out )
        .map(({ amount_out, exchanger_flag, routes, ...rest }: { amount_out: number, exchanger_flag: string, routes: any[] }) => ({
          ...rest,
          routes,
          output: amount_out / 10 ** decimals[1], 
          provider: PROVIDER_MAP[exchanger_flag],
          offset: best ? (amount_out - best.amount_out) / best.amount_out * 100 : 0,
          id: `${routes.flat(2).reduce((acc, cur) => `${acc}-${cur.pubkey}`, exchanger_flag)}`
        }))
      ]

      // result list
      setDistributions(result)

      if (!choice.current && result.length) {
        // setChoice(result[0].id)
        choice.current = result[0].id
      }

      setAmounts(amounts)

      setTimeoutLoading(true)
      timer.current = setTimeout(() => { 
        fetchDistrubition() 
      }, 10 * 1000)
    } catch(e) {
      setAmounts([])
      setDistributions([])
    }

    refreshBtnRef.current.classList.remove('refresh-btn')
    void refreshBtnRef.current.offsetHeight
    refreshBtnRef.current.classList.add('refresh-btn')

    setLoading(false)
  }, [A.mint, A.mintAddress, A.amount, B.mint, B.mintAddress, CancelToken, chainId, tokenMap])

  useEffect(() => {
    setAmounts([])
    setDistributions([])
    // setChoice('')
    choice.current = ''

    refreshBtnRef.current.classList.remove('refresh-btn')
    void refreshBtnRef.current.offsetHeight
    refreshBtnRef.current.classList.add('refresh-btn')
    setTimeoutLoading(false)

    if (cancel.current) {
      cancel.current()
    }

    if (timer.current) {
      clearTimeout(timer.current)
    }

    if (
      A.mintAddress && 
      B.mintAddress && 
      Number(A.amount) &&
      A.mintAddress !== B.mintAddress
    ) {
      fetchDistrubition()
    } 

    return () => {
      if (timer.current) {
        clearTimeout(timer.current)
      }
    }
  }, [A.amount, A.mintAddress, B.mintAddress, fetchDistrubition])

  const swapAccounts = () => {
    const tempMint = A.mintAddress;
    // const tempAmount = A.amount;

    A.setMint(B.mintAddress);
    // A.setAmount(B.amount);
    B.setMint(tempMint);
    // B.setAmount(tempAmount);

    // @ts-ignore
    setPoolOperation((op: PoolOperation) => {
      switch (+op) {
        case PoolOperation.SwapGivenInput:
          return PoolOperation.SwapGivenProceeds;
        case PoolOperation.SwapGivenProceeds:
          return PoolOperation.SwapGivenInput;
        case PoolOperation.Add:
          return PoolOperation.SwapGivenInput;
      }
    });
  };

  const handleSwap = async () => {
    if (!A.amount || !B.mintAddress) {
      return
    }

    try {
      setPendingTx(true);

      const components = [
        {
          account: A.account,
          mintAddress: A.mintAddress,
          amount: A.convertAmount(),
        },
        {
          mintAddress: B.mintAddress,
          amount: B.convertAmount(), 
        },
      ];

      const distribution = distributions.find(({id}: {id: string}) => id === choice.current)

      if (!distribution || !distribution.routes.length) {
        return
      }

      let amms: AmmInfo[] = [] 

      distribution.routes.forEach((route: any[]) => {
        const [first] = route

        if (first) {
          const ammInfo: AmmInfo | undefined = ammInfos.find((pool: AmmInfo) => {
            const mints: string[] = [pool.tokenMintA().toBase58(), pool.tokenMintB().toBase58()]

            return mints.includes(first.source_token_mint.pubkey) && mints.includes(first.destination_token_mint.pubkey)
          })

          if (ammInfo) {
            amms.push(ammInfo)
          }
        }
      })

      await onesolProtocolSwap(connection, wallet, A, B, amms, distribution, components, slippage);

      setShowShare(true)
    } catch (e) {
      console.error(e)

      notify({
        description: "Please try again and approve transactions from your wallet",
        message: "Swap trade cancelled.",
        type: "error",
      });
    } finally {
      setPendingTx(false);
    }
  };

  const handleSwitchChoice = (s: string) => {
    // setChoice(choice) 
    choice.current = s
  }

  const handleRefresh = () => { 
    setLoading(true)
    setDistributions([])
    setAmounts([])
    // setChoice(ONESOL_NAME)
    choice.current = ''

    setTimeoutLoading(false)
    // refreshBtnRef.current.classList.remove('timeout')
  }

  const handleShowRoute = () => setShowRoute(true)

  useEffect(() => {
    let label: string[] = []

    amounts.forEach(routes => {
      const [first] = routes

      if (first) {
        label.push(first.from)
        label.push(first.to)
      }
    })

    setRouteLable([...new Set(label)])
  }, [amounts])


  const handleCreateTokenAccount = async () => {
    if (B.mintAddress) {
      try {
        setPendingTx(true);

        await createTokenAccount(connection, wallet, new PublicKey(B.mintAddress));

        setHasTokenAccount(true)
      } catch (e) {
        console.error(e)

        notify({
          description:
            "Please try again",
          message: "Create account cancelled.",
          type: "error",
        });
      } finally {
        setPendingTx(false);
      }
    }
  }

  return (
    <>
      <div className="trade-header">
        <div className="hd">Trade(devnet)</div>
        <div className="bd">
          <Button
            ref={refreshBtnRef}
            className={classNames('refresh-btn', {loading: loading}, {timeout: timeoutLoading})}
            shape="circle"
            size="large"
            type="text"
            onClick={handleRefresh}
            disabled={loading}
          >
            <ReloadOutlined spin={loading} />
          </Button>
          <Popover
            placement="rightTop"
            title="Settings"
            content={<Settings />}
            trigger="click"
          >
            <Button
              shape="circle"
              size="large"
              type="text"
              icon={<SettingOutlined />}
            />
          </Popover>
        </div>
      </div>
      <div className="input-card">
        <CurrencyInput
          title="From"
          onInputChange={(val: any) => {
            setPoolOperation(PoolOperation.SwapGivenInput);

            if (A.amount !== val) {
              setLastTypedAccount(A.mintAddress);
            }

            A.setAmount(val);
          }}
          amount={A.amount}
          mint={A.mintAddress}
          onMintChange={(item) => {
            A.setMint(item);
          }}
        />
        <Button
         type="primary" 
         className="swap-button" 
         style={{display: 'flex', justifyContent: 'space-around', margin: '-10px auto'}}
         onClick={swapAccounts}
        >
          {/* &#8595; */}
          &#10607;
        </Button>
        <Card
          style={{ borderRadius: 20, margin: 0, width: '100%' }}
          bodyStyle={{ padding: 0 }}
        >
        <QuoteCurrencyInput
          title="To(estimated)"
          onInputChange={(val: any) => {
            setPoolOperation(PoolOperation.SwapGivenProceeds);

            if (B.amount !== val) {
              setLastTypedAccount(B.mintAddress);
            }

            B.setAmount(val);
          }}
          amount={B.amount}
          mint={B.mintAddress}
          onMintChange={(item) => {
            B.setMint(item);
          }}
          disabled
        />
        <Result
         loading={loading && !distributions.length} 
         data={distributions} 
         active={choice.current} 
         handleSwitchChoice={handleSwitchChoice} 
         handleShowRoute={handleShowRoute} 
         routes={routeLabel}
        />
      </Card>
      </div>
      <Button
        className="trade-button"
        type="primary"
        size="large"
        shape="round"
        block
        onClick={connected ? hasTokenAccount ? handleSwap : handleCreateTokenAccount : connect}
        style={{ marginTop: '20px' }}
        disabled={
          connected &&
          (
            pendingTx ||
            !A.account ||
            !B.mintAddress ||
            A.account === B.account ||
            !A.sufficientBalance() ||
            !distributions.length
          )
        }
      >
        {generateActionLabel(
        !distributions.length && !loading
          ? POOL_NOT_AVAILABLE(
              getTokenName(tokenMap, A.mintAddress),
              getTokenName(tokenMap, B.mintAddress)
            )
        : 
        SWAP_LABEL,
        connected,
        tokenMap,
        A,
        B,
        true,
        hasTokenAccount
        )}
        {pendingTx && <Spin indicator={antIcon} className="trade-spinner" />}
      </Button>

      <Modal width={580} visible={showRoute} centered footer={null} onCancel={() => setShowRoute(false)}>
        {amounts.length ? <TradeRoute amounts={amounts} /> : null}
      </Modal>

      <div className={classNames("twitter-share", {show: showShare})}>
        <div className="mask"onClick={() => setShowShare(false)}></div>
        <div className="bd">
          <div className="inner">
            <div className="in">
              <div className="text">
                <h4>Get 1 & Win 200 1SOL!</h4>
                <p>1. Tweet using this link:
                  <Button type="primary" size="small" style={{marginLeft: '5px'}}>
                    <a className="twitter-share-button"
                      href={`https://twitter.com/intent/tweet?url=${encodeURI('https://devnet.1sol.io')}&text=${encodeURIComponent("🚀Just successfully swapped tokens via #1SOL dex aggregator on #Solana Devnet. @1solProtocol @solana @SBF_FTX. Join the devnet test to get the airdrop and win a daily 200 prize here!🎁")}&via=1solProtocol&hashtags=DeFi,Solana,1SOL,SOL,Ignition`}
                      target="_blank"
                      rel="noopener noreferrer"
                      data-size="large"
                    >Tweet</a>
                  </Button>
                </p>
                <p>2. Talk to <a href="https://t.me/OnesolMasterBot" target="_blank" rel="noopener noreferrer">1Sol’s Telegram Bot</a> to confirm the airdrop</p>
                <p>3. We’re announce the daily 200-token winner via <a href="https://discord.com/invite/juvVBKnvkj" target="_blank" rel="noopener noreferrer">Discord</a> <a href="https://t.me/onesolcommunity" target="_blank" rel="noopener noreferrer">Telegram</a> <a href="https://twitter.com/1solprotocol" target="_blank" rel="noopener noreferrer">Twitter</a></p>
              </div>
            </div>
            <Button onClick={() => setShowShare(false)} size="large" className="btn-close" icon={<CloseCircleOutlined />}></Button>
          </div>
        </div>
      </div>
    </>
  );
};

export const Result = (props: {
  data: Distribution[], 
  loading: boolean, 
  handleSwitchChoice: (a: string) => void,
  handleShowRoute: () => void,
  active?: string,
  routes?: string[]
}) => {
  const {data, loading, handleSwitchChoice, active, handleShowRoute, routes} = props

  return (
    <div className="mod-results">
      <Skeleton paragraph={{rows: 1, width: '100%'}} title={false}  active loading={loading}>
        {data.map(({provider, output, offset, id}, i) => (
          <div
            key={id}
            className={id === active ? "mod-result active": 'mod-result'}
            onClick={() => handleSwitchChoice(id)}
          >
            <div className="hd">{provider}</div>
            <div className="bd">
              <div className="number">{output}{offset ? `(${offset.toFixed(2)}%)`: ''}</div>
              {
                i === 0 ?
                <div onClick={handleShowRoute} className="route">
                  { routes ? routes.map((label: string, i: number) => (
                    <span key={i}>
                      {label}
                      {
                        i !== routes.length -1 ? <RightOutlined style={{margin: '0 2px'}} /> : null
                      }
                    </span>
                  )): null }
                  {/* {A.name} &#10148; {B.name} */}
                  <ExpandOutlined style={{marginLeft: '5px'}} /> 
                </div> : 
                null
              }
            </div>
            {i === 0 ? <div className="ft">Best</div> : null}
          </div>
        ))}
      </Skeleton>
    </div>
  )
}

export const TradeRoute = (props: { amounts: Route[][] }) => {
  const { A, B } = useCurrencyPairState();
  const {amounts} = props

  return (
    <div className="trade-route">
      <div className="hd"><TokenIcon mintAddress={A.mintAddress} style={{width: '30px', height: '30px'}} /></div>
      <RightOutlined style={{margin: '0 5px'}} />
      <div className="bd">
        {amounts.map((routes, i: number) => (
          <>
            <div className="token-route" key={i}>
              {routes.map((route, j: number) => (
                <>
                  <div className="market-route" key={j}>
                    <div className="pool">
                      <div className="name">{route.provider}</div>
                      <div className="amount">
                        <span>{route.from}</span>
                        <ArrowRightOutlined />
                        <span>{route.to}</span>
                        <span>{route.ratio}%</span>
                      </div>
                    </div>
                  </div>
                  {
                    j !== routes.length - 1 ?
                    <PlusOutlined style={{margin: '5px 0'}} />
                    : null
                  }
                </>
              ))}
            </div>
            {
              i !== amounts.length - 1 ?
                <RightOutlined style={{margin: '0 10px'}} />
              : null
            }
          </>
        ))}  
      </div>
      <RightOutlined style={{margin: '0 5px'}} />
      <div className="ft"><TokenIcon mintAddress={B.mintAddress} style={{width: '30px', height: '30px', margin: '0.11rem 0 0 0.5rem'}} /></div>
    </div>
  )
}
