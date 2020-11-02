import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button, Popover, Table } from "antd";
import { AppBar } from "./../appBar";
import {
  cache,
  getMultipleAccounts,
  MintParser,
  ParsedAccountBase,
  useCachedPool,
} from "../../utils/accounts";
import { convert, getPoolName, STABLE_COINS } from "../../utils/utils";
import { useConnectionConfig } from "../../utils/connection";
import { Settings } from "../settings";
import { SettingOutlined } from "@ant-design/icons";
import { PoolIcon } from "../tokenIcon";
import { Market, MARKETS, Orderbook, TOKEN_MINTS } from "@project-serum/serum";
import { AccountInfo, Connection, PublicKey } from "@solana/web3.js";
import { Input } from "antd";
import { POOLS_WITH_AIRDROP } from "./../../models/airdrops";
import { MINT_TO_MARKET } from "./../../models/marketOverrides";

import "./styles.less";
import echarts from "echarts";
import { PoolInfo } from "../../models";

const { Search } = Input;

const FlashText = (props: { text: string; val: number }) => {
  const [activeClass, setActiveClass] = useState("");
  const [value] = useState(props.val);
  useEffect(() => {
    if (props.val !== value) {
      setActiveClass(props.val > value ? "flash-positive" : "flash-negative");

      setTimeout(() => setActiveClass(""), 200);
    }
  }, [props.text, props.val, value]);

  return <span className={activeClass}>{props.text}</span>;
};

const INITAL_LIQUIDITY_DATE = new Date("2020-10-27");
const REFRESH_INTERVAL = 30_000;

const OrderBookParser = (id: PublicKey, acc: AccountInfo<Buffer>) => {
  const decoded = Orderbook.LAYOUT.decode(acc.data);

  const details = {
    pubkey: id,
    account: {
      ...acc,
    },
    info: decoded,
  } as ParsedAccountBase;

  return details;
};

const getMidPrice = (marketAddress: string, mintAddress: string) => {
  const SERUM_TOKEN = TOKEN_MINTS.find(
    (a) => a.address.toBase58() === mintAddress
  );

  if (STABLE_COINS.has(SERUM_TOKEN?.name || "")) {
    return 1.0;
  }

  const marketInfo = cache.get(marketAddress);
  if (!marketInfo) {
    return 0.0;
  }

  const decodedMarket = marketInfo.info;
  const baseMintDecimals =
    cache.get(decodedMarket.baseMint)?.info.decimals || 0;
  const quoteMintDecimals =
    cache.get(decodedMarket.quoteMint)?.info.decimals || 0;

  const market = new Market(
    decodedMarket,
    baseMintDecimals,
    quoteMintDecimals,
    undefined,
    decodedMarket.programId
  );

  const bids = cache.get(decodedMarket.bids)?.info;
  const asks = cache.get(decodedMarket.asks)?.info;

  const bidsBook = new Orderbook(market, bids.accountFlags, bids.slab);
  const asksBook = new Orderbook(market, asks.accountFlags, asks.slab);

  const bestBid = bidsBook.getL2(1);
  const bestAsk = asksBook.getL2(1);

  if (bestBid.length > 0 && bestAsk.length > 0) {
    return (bestBid[0][0] + bestAsk[0][0]) / 2.0;
  }

  return 0;
};

interface SerumMarket {
  marketInfo: {
    address: PublicKey;
    name: string;
    programId: PublicKey;
    deprecated: boolean;
  };

  // 1st query
  marketAccount?: AccountInfo<Buffer>;

  // 2nd query
  mintBase?: AccountInfo<Buffer>;
  mintQuote?: AccountInfo<Buffer>;
  bidAccount?: AccountInfo<Buffer>;
  askAccount?: AccountInfo<Buffer>;
}

interface Totals {
  liquidity: number;
  volume: number;
  fees: number;
}

export const ChartsView = React.memo(() => {
  const { env, endpoint } = useConnectionConfig();
  const { pools } = useCachedPool();
  const [dataSource, setDataSource] = useState<any[]>([]);
  const [search, setSearch] = useState<string>("");
  const [totals, setTotals] = useState<Totals>(() => ({
    liquidity: 0,
    volume: 0,
    fees: 0,
  }));
  const chartDiv = useRef<HTMLDivElement>(null);
  const echartsRef = useRef<any>(null);
  // separate connection for market updates
  const connection = useMemo(() => new Connection(endpoint, "recent"), [
    endpoint,
  ]);

  useEffect(() => {
    if (chartDiv.current) {
      echartsRef.current = echarts.init(chartDiv.current);
    }

    return () => {
      echartsRef.current.dispose();
    };
  }, []);

  // TODO: display user percent in the pool
  // const { ownedPools } = useOwnedPools();

  // TODO: create cache object with layout type, get, query, add

  let searchRegex: RegExp;
  try {
    searchRegex = new RegExp(search, "i");
  } catch {
    // ignore bad regex typed by user
  }

  const updateChart = useCallback(() => {
    if (echartsRef.current) {
      echartsRef.current.setOption({
        series: [
          {
            name: "Liquidity",
            type: "treemap",
            top: 0,
            bottom: 10,
            left: 30,
            right: 30,
            // visibleMin: 300,
            label: {
              show: true,
              formatter: "{b}",
            },
            itemStyle: {
              normal: {
                borderColor: "#000",
              },
            },
            breadcrumb: {
              show: false,
            },
            data: dataSource
              .filter(
                (row) => !search || !searchRegex || searchRegex.test(row.name)
              )
              .map((row) => {
                return {
                  value: row.liquidity,
                  name: row.name,
                  path: `Liquidity/${row.name}`,
                  data: row,
                };
              }),
          },
        ],
      });
    }
  }, [dataSource, echartsRef.current, search]);

  // Updates total values
  useEffect(() => {
    setTotals(
      dataSource.reduce(
        (acc, item) => {
          acc.liquidity = acc.liquidity + item.liquidity;
          acc.volume = acc.volume + item.volume;
          acc.fees = acc.fees + item.fees;
          return acc;
        },
        { liquidity: 0, volume: 0, fees: 0 } as Totals
      )
    );

    updateChart();
  }, [dataSource, updateChart, search]);

  useEffect(() => {
    const reverseSerumMarketCache = new Map<string, string>();
    const marketByMint = [
      ...new Set(pools.map((p) => p.pubkeys.holdingMints).flat()).values(),
    ].reduce((acc, key) => {
      const mintAddress = key.toBase58();

      const SERUM_TOKEN = TOKEN_MINTS.find(
        (a) => a.address.toBase58() === mintAddress
      );

      const marketAddress = MINT_TO_MARKET[mintAddress];
      const marketName = `${SERUM_TOKEN?.name}/USDC`;
      const marketInfo = MARKETS.find(
        (m) => m.name === marketName || m.address.toBase58() === marketAddress
      );

      if (marketInfo) {
        reverseSerumMarketCache.set(marketInfo.address.toBase58(), mintAddress);

        acc.set(mintAddress, {
          marketInfo,
        });
      }

      return acc;
    }, new Map<string, SerumMarket>());

    let timer = 0;

    const toQuery = new Set<string>();
    const accountsToObserve = new Set<string>();

    const refreshAccounts = async (keys: string[]) => {
      return getMultipleAccounts(connection, keys, "single").then(
        ({ keys, array }) => {
          return array.map((item, index) => {
            const address = keys[index];
            return cache.add(new PublicKey(address), item);
          });
        }
      );
    };

    const updateData = async () => {
      const TODAY = new Date();

      await refreshAccounts([...accountsToObserve.keys()]);

      setDataSource(
        pools
          .filter(
            (p) => p.pubkeys.holdingMints && p.pubkeys.holdingMints.length > 1
          )
          .map((p, index) => {
            const mints = (p.pubkeys.holdingMints || [])
              .map((a) => a.toBase58())
              .sort();
            const indexA =
              mints[0] === p.pubkeys.holdingMints[0]?.toBase58() ? 0 : 1;
            const indexB = indexA === 0 ? 1 : 0;
            const accountA = cache.getAccount(
              p.pubkeys.holdingAccounts[indexA]
            );
            const mintA = cache.getMint(mints[0]);
            const accountB = cache.getAccount(
              p.pubkeys.holdingAccounts[indexB]
            );
            const mintB = cache.getMint(mints[1]);

            const baseReserveUSD =
              getMidPrice(
                marketByMint.get(mints[0])?.marketInfo.address.toBase58() || "",
                mints[0]
              ) * convert(accountA, mintA);
            const quoteReserveUSD =
              getMidPrice(
                marketByMint.get(mints[1])?.marketInfo.address.toBase58() || "",
                mints[1]
              ) * convert(accountB, mintB);

            const poolMint = cache.getMint(p.pubkeys.mint);
            if (poolMint?.supply.eqn(0)) {
              return;
            }

            let airdropYield = calculateAirdropYield(
              p,
              marketByMint,
              baseReserveUSD,
              quoteReserveUSD
            );

            let volume = 0;
            let fees = 0;
            let apy = airdropYield;
            if (p.pubkeys.feeAccount) {
              const feeAccount = cache.getAccount(p.pubkeys.feeAccount);

              if (
                poolMint &&
                feeAccount &&
                feeAccount.info.mint.toBase58() === p.pubkeys.mint.toBase58()
              ) {
                const feeBalance = feeAccount?.info.amount.toNumber();
                const supply = poolMint?.supply.toNumber();

                const ownedPct = feeBalance / supply;

                const poolOwnerFees =
                  ownedPct * baseReserveUSD + ownedPct * quoteReserveUSD;
                volume = poolOwnerFees / 0.0004;
                fees = volume * 0.003;

                if (fees !== 0) {
                  const baseVolume = (ownedPct * baseReserveUSD) / 0.0004;
                  const quoteVolume = (ownedPct * quoteReserveUSD) / 0.0004;

                  // Aproximation not true for all pools we need to fine a better way
                  const daysSinceInception = Math.floor(
                    (TODAY.getTime() - INITAL_LIQUIDITY_DATE.getTime()) /
                      (24 * 3600 * 1000)
                  );
                  const apy0 =
                    parseFloat(
                      ((baseVolume / daysSinceInception) * 0.003 * 356) as any
                    ) / baseReserveUSD;
                  const apy1 =
                    parseFloat(
                      ((quoteVolume / daysSinceInception) * 0.003 * 356) as any
                    ) / quoteReserveUSD;

                  apy = apy + Math.max(apy0, apy1);
                }
              }
            }

            const lpMint = cache.getMint(p.pubkeys.mint);

            const name = getPoolName(env, p);
            const link = `#/?pair=${name.replace("/", "-")}`;

            return {
              key: p.pubkeys.account.toBase58(),
              id: index,
              name,
              address: p.pubkeys.mint.toBase58(),
              link,
              mints,
              liquidityA: convert(accountA, mintA),
              liquidityAinUsd: baseReserveUSD,
              liquidityB: convert(accountB, mintB),
              liquidityBinUsd: quoteReserveUSD,
              supply:
                lpMint &&
                (
                  lpMint?.supply.toNumber() /
                  Math.pow(10, lpMint?.decimals || 0)
                ).toFixed(9),
              fees,
              liquidity: baseReserveUSD + quoteReserveUSD,
              volume,
              apy,
              raw: p,
            };
          })
          .filter((p) => p)
      );

      timer = window.setTimeout(() => updateData(), REFRESH_INTERVAL);
    };

    const initalQuery = async () => {
      const allMarkets = [...marketByMint.values()].map((m) =>
        m.marketInfo.address.toBase58()
      );

      await getMultipleAccounts(
        connection,
        // only query for markets that are not in cahce
        allMarkets.filter((a) => cache.get(a) === undefined),
        "single"
      ).then(({ keys, array }) => {
        return array.map((item, index) => {
          const marketAddress = keys[index];
          const mintAddress = reverseSerumMarketCache.get(marketAddress);
          if (mintAddress) {
            const market = marketByMint.get(mintAddress);

            if (market) {
              const programId = market.marketInfo.programId;
              const id = market.marketInfo.address;
              cache.add(id, item, (id, acc) => {
                const decoded = Market.getLayout(programId).decode(acc.data);

                const details = {
                  pubkey: id,
                  account: {
                    ...acc,
                  },
                  info: decoded,
                } as ParsedAccountBase;

                cache.registerParser(details.info.baseMint, MintParser);
                cache.registerParser(details.info.quoteMint, MintParser);
                cache.registerParser(details.info.bids, OrderBookParser);
                cache.registerParser(details.info.asks, OrderBookParser);

                return details;
              });
            }
          }

          return item;
        });
      });

      allMarkets.forEach((m) => {
        const market = cache.get(m);
        if (!market) {
          return;
        }

        const decoded = market;

        if (!cache.get(decoded.info.baseMint)) {
          toQuery.add(decoded.info.baseMint.toBase58());
        }

        if (!cache.get(decoded.info.baseMint)) {
          toQuery.add(decoded.info.quoteMint.toBase58());
        }

        toQuery.add(decoded.info.bids.toBase58());
        accountsToObserve.add(decoded.info.bids.toBase58());

        toQuery.add(decoded.info.asks.toBase58());
        accountsToObserve.add(decoded.info.asks.toBase58());
      });

      await refreshAccounts([...toQuery.keys()]);

      // start update loop
      updateData();
    };

    initalQuery();

    return () => {
      window.clearTimeout(timer);
    };
  }, [pools]);

  const formatUSD = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  });
  const formatPct = new Intl.NumberFormat("en-US", {
    style: "percent",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  const columns = [
    {
      title: "Name",
      dataIndex: "name",
      key: "name",
      render(text: string, record: any) {
        return {
          props: {
            style: {},
          },
          children: (
            <div style={{ display: "flex" }}>
              <PoolIcon mintA={record.mints[0]} mintB={record.mints[1]} />
              <a href={record.link} target="_blank" rel="noopener noreferrer">
                {text}
              </a>
            </div>
          ),
        };
      },
    },
    {
      title: "Liquidity",
      dataIndex: "liquidity",
      key: "liquidity",
      render(text: string, record: any) {
        return {
          props: {
            style: { textAlign: "right" },
          },
          children: (
            <FlashText
              text={formatUSD.format(record.liquidity)}
              val={record.liquidity}
            />
          ),
        };
      },
      sorter: (a: any, b: any) => a.liquidity - b.liquidity,
      defaultSortOrder: "descend" as any,
    },
    {
      title: "Supply",
      dataIndex: "supply",
      key: "supply",
      render(text: string, record: any) {
        return {
          props: {
            style: { textAlign: "right" },
          },
          children: <FlashText text={text} val={record.supply} />,
        };
      },
      sorter: (a: any, b: any) => a.supply - b.supply,
    },
    {
      title: "Volume",
      dataIndex: "volume",
      key: "volume",
      render(text: string, record: any) {
        return {
          props: {
            style: { textAlign: "right" },
          },
          children: (
            <FlashText
              text={formatUSD.format(record.volume)}
              val={record.volume}
            />
          ),
        };
      },
      sorter: (a: any, b: any) => a.volume - b.volume,
    },
    {
      title: "Fees",
      dataIndex: "fees",
      key: "fees",
      render(text: string, record: any) {
        return {
          props: {
            style: { textAlign: "right" },
          },
          children: (
            <FlashText text={formatUSD.format(record.fees)} val={record.fees} />
          ),
        };
      },
    },
    {
      title: "APY",
      dataIndex: "apy",
      key: "apy",
      render(text: string, record: any) {
        return {
          props: {
            style: { textAlign: "right" },
          },
          children: formatPct.format(record.apy),
        };
      },
      sorter: (a: any, b: any) => a.apy - b.apy,
    },
    {
      title: "Address",
      dataIndex: "address",
      key: "address",
      render(text: string) {
        return {
          props: {
            style: { fontFamily: "monospace" } as React.CSSProperties,
          },
          children: <span>{text}</span>,
        };
      },
    },
  ];

  return (
    <>
      <AppBar
        right={
          <Popover
            placement="topRight"
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
        }
      />
      <div className="info-header">
        <h1>Liquidity: {formatUSD.format(totals.liquidity)}</h1>
        <h1>Volume: {formatUSD.format(totals.volume)}</h1>
        <Search
          className="search-input"
          placeholder="Filter"
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onSearch={(value) => setSearch(value)}
          style={{ width: 200 }}
        />
      </div>
      <div ref={chartDiv} style={{ height: "250px", width: "100%" }} />
      <Table
        dataSource={dataSource.filter(
          (row) => !search || !searchRegex || searchRegex.test(row.name)
        )}
        columns={columns}
        size="small"
        pagination={{ pageSize: 10 }}
      />
    </>
  );
});

function calculateAirdropYield(
  p: PoolInfo,
  marketByMint: Map<string, SerumMarket>,
  baseReserveUSD: number,
  quoteReserveUSD: number
) {
  let airdropYield = 0;
  let poolWithAirdrop = POOLS_WITH_AIRDROP.find((drop) =>
    drop.pool.equals(p.pubkeys.mint)
  );
  if (poolWithAirdrop) {
    airdropYield = poolWithAirdrop.airdrops.reduce((acc, item) => {
      const market = marketByMint.get(item.mint.toBase58())?.marketInfo.address;
      if (market) {
        const midPrice = getMidPrice(market?.toBase58(), item.mint.toBase58());

        acc =
          acc +
          // airdrop yield
          ((item.amount * midPrice) / (baseReserveUSD + quoteReserveUSD)) *
            (365 / 30);
      }

      return acc;
    }, 0);
  }
  return airdropYield;
}
