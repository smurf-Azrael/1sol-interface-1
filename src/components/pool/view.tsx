import React from 'react';
import { List, ConfigProvider, Empty } from 'antd'
import { useOwnedPools } from './../../utils/pools';
import {RemoveLiquidity} from './remove';
import { getPoolName } from '../../utils/utils';
import { useMint } from '../../utils/accounts';
import { useConnectionConfig } from '../../utils/connection';
import { PoolIcon, TokenIcon } from '../tokenIcon';
import { PoolInfo, TokenAccount } from '../../models';

const PoolItem = (props: { item: { pool: PoolInfo, account: TokenAccount } }) => {
    const { env } = useConnectionConfig();
    const item = props.item;
    const mint = useMint(item.account.info.mint.toBase58());
    
    const amount = item.account.info.amount.toNumber() / Math.pow(10, mint?.decimals || 0);

    if(!amount) {
        return null;
    }

    const sorted = item.pool.pubkeys.accountMints.map(a => a.toBase58()).sort();

    if (item) {
        return <List.Item
            actions={[
                <RemoveLiquidity instance={item} />
            ]}
        >
            <div>{amount.toFixed(2)}</div>
            <PoolIcon mintA={sorted[0]} mintB={sorted[1]} style={{ marginLeft: '0.5rem' }} />
            <div>{getPoolName(env, item.pool)}</div>
        </List.Item>;
    }

    return null;
}

export const PoolAccounts = () => {
    const pools = useOwnedPools();

    return <>
        <div>
            Your Liquidity
        </div>

        <ConfigProvider renderEmpty={() => <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No liquidity found." />}>
            <List
                size="small"
                dataSource={pools}
                renderItem={item  => <PoolItem item={item} />}
            />
        </ConfigProvider>
    </>;
}