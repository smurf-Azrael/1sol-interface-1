import { Account, Connection, PublicKey, sendAndConfirmRawTransaction, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { useConnection } from "./connection";
import * as BufferLayout from 'buffer-layout';
import { useWallet } from "./wallet";
import { useEffect, useState } from "react";
import { Token, MintLayout, AccountLayout } from '@solana/spl-token';
import { TokenSwap, TokenSwapLayout } from '@solana/spl-token-swap';
import { notify } from "./notifications";
import { cache, getCachedAccount, TokenAccount, useUserAccounts, useCachedPool } from "./accounts";
import { programIds, WRAPPED_SOL_MINT } from './ids';

const LIQUIDITY_TOKEN_PRECISION = 8;

export interface PoolInfo {
    pubkeys: {
        program: PublicKey;
        accounts: PublicKey[];
        accountMints: PublicKey[];
        mint: PublicKey;
    };
    raw: any;
}

const createInitSwapInstruction = (
    tokenSwapAccount: Account,
    authority: PublicKey,
    nonce: number,
    tokenAccountA: PublicKey,
    tokenAccountB: PublicKey,
    tokenPool: PublicKey,
    tokenAccountPool: PublicKey,
    tokenProgramId: PublicKey,
    swapProgramId: PublicKey,
    feeNumerator: number,
    feeDenominator: number,
) => {
    const keys = [
        { pubkey: tokenSwapAccount.publicKey, isSigner: false, isWritable: true },
        { pubkey: authority, isSigner: false, isWritable: false },
        { pubkey: tokenAccountA, isSigner: false, isWritable: false },
        { pubkey: tokenAccountB, isSigner: false, isWritable: false },
        { pubkey: tokenPool, isSigner: false, isWritable: true },
        { pubkey: tokenAccountPool, isSigner: false, isWritable: true },
        { pubkey: tokenProgramId, isSigner: false, isWritable: false },
    ];
    const commandDataLayout = BufferLayout.struct([
        BufferLayout.u8('instruction'),
        BufferLayout.nu64('feeNumerator'),
        BufferLayout.nu64('feeDenominator'),
        BufferLayout.u8('nonce'),
    ]);
    let data = Buffer.alloc(1024);
    {
        const encodeLength = commandDataLayout.encode(
            {
                instruction: 0, // InitializeSwap instruction
                feeNumerator,
                feeDenominator,
                nonce,
            },
            data,
        );
        data = data.slice(0, encodeLength);
    }
    return new TransactionInstruction({
        keys,
        programId: swapProgramId,
        data,
    });
}

export const sendTransaction = async (connection: any, wallet: any, instructions: TransactionInstruction[], signers: Account[]) => {
    let transaction = new Transaction();
    instructions.forEach(instruction => transaction.add(instruction));
    transaction.recentBlockhash = (await connection.getRecentBlockhash('max')).blockhash;
    transaction.setSigners(
        // fee payied by the wallet owner
        wallet.publicKey,
        ...signers.map(s => s.publicKey)
    );
    if (signers.length > 0) {
        transaction.partialSign(...signers);
    }
    transaction = await wallet.signTransaction(transaction);
    const rawTransaction = transaction.serialize();
    const txid = await sendAndConfirmRawTransaction(
        connection,
        rawTransaction, {
        skipPreflight: true,
        commitment: 'singleGossip'
    });

    return txid;
}
export interface LiquidityComponent {
    amount: number;
    account: TokenAccount;
}

export const removeLiquidity = async (connection: Connection, wallet: any, liquidityAmount: number, account: TokenAccount, pool?: PoolInfo) => {
    if (!pool) {
        return;
    }

    notify({
        message: 'Removing Liquidity...',
        description: 'Please review transactions to approve.',
        type: 'warn'
    });

    // TODO get min amounts based on total supply and liquidity
    const minAmount0 = 0;
    const minAmount1 = 0;

    const poolMint = await cache.getMint(connection, pool.pubkeys.mint);
    const accountA = await cache.getAccount(connection, pool.pubkeys.accounts[0]);
    const accountB = await cache.getAccount(connection, pool.pubkeys.accounts[1]);
    if (!poolMint.mintAuthority) {
        throw new Error('Mint doesnt have authority')
    }
    const authority = poolMint.mintAuthority;

    const signers: Account[] = [];
    const instructions: TransactionInstruction[] = [];
    const cleanupInstructions: TransactionInstruction[] = [];


    const accountRentExempt = await connection.getMinimumBalanceForRentExemption(AccountLayout.span);

    // TODO: check if one of to accounts needs to be native sol ... if yes unwrap it ...
    const toAccounts: PublicKey[] = [
        await findOrCreateAccountByMint(
            connection,
            wallet.publicKey,
            wallet.publicKey,
            instructions,
            cleanupInstructions,
            accountRentExempt,
            accountA.info.mint,
            signers),
        await findOrCreateAccountByMint(
            connection,
            wallet.publicKey,
            wallet.publicKey,
            instructions,
            cleanupInstructions,
            accountRentExempt,
            accountB.info.mint,
            signers),
    ];

    instructions.push(Token.createApproveInstruction(
        programIds().token,
        account.pubkey,
        authority,
        wallet.publicKey,
        [],
        liquidityAmount,
    ));

    // withdraw
    instructions.push(
        TokenSwap.withdrawInstruction(
            pool.pubkeys.program,
            authority,
            pool.pubkeys.mint,
            account.pubkey,
            pool.pubkeys.accounts[0],
            pool.pubkeys.accounts[1],
            toAccounts[0],
            toAccounts[1],
            programIds().swap,
            programIds().token,
            liquidityAmount,
            minAmount0,
            minAmount1
        )
    );

    let tx = await sendTransaction(connection, wallet, instructions.concat(cleanupInstructions), signers);

    notify({
        message: 'Liquidity Returned. Thank you for your support.',
        type: 'success',
        description: `Transaction - ${tx}`,
    });
};

export const swap = async (connection: Connection, wallet: any, components: LiquidityComponent[], pool?: PoolInfo) => {
    if (!pool) {
        notify({
            type: 'error',
            message: `Pool doesn't exsist.`,
            description: `Swap trade cancelled`,
        })
        return;
    }


    const SLIPPAGE = 1 // 1% TODO: customize for now 100% for demo purpose

    // Uniswap whitepaper: https://uniswap.org/whitepaper.pdf       
    // see: https://uniswap.org/docs/v2/advanced-topics/pricing/
    // as well as native uniswap v2 oracle: https://uniswap.org/docs/v2/core-concepts/oracles/
    const amountIn = components[0].amount; // these two should include slippage
    const minAmountOut = components[1].amount * (1 - SLIPPAGE);
    const holdingA = pool.pubkeys.accountMints[0].toBase58() === components[0].account.info.mint.toBase58() ? pool.pubkeys.accounts[0] : pool.pubkeys.accounts[1];
    const holdingB = holdingA === pool.pubkeys.accounts[0] ? pool.pubkeys.accounts[1] : pool.pubkeys.accounts[0];

    const poolMint = await cache.getMint(connection, pool.pubkeys.mint);
    if (!poolMint.mintAuthority) {

        throw new Error('Mint doesnt have authority')
    }
    const authority = poolMint.mintAuthority;

    const instructions: TransactionInstruction[] = [];
    const cleanupInstructions: TransactionInstruction[] = [];
    const signers: Account[] = [];

    const accountRentExempt = await connection.getMinimumBalanceForRentExemption(AccountLayout.span);

    const fromAccount = getWrappedAccount(
        instructions,
        cleanupInstructions,
        components[0].account,
        wallet.publicKey,
        amountIn + accountRentExempt,
        signers);

    let toAccount = findOrCreateAccountByMint(
        connection,
        wallet.publicKey,
        wallet.publicKey,
        instructions,
        cleanupInstructions,
        accountRentExempt,
        components[1].account.info.mint,
        signers);

    // create approval for transfer transactions
    instructions.push(Token.createApproveInstruction(
        programIds().token,
        fromAccount,
        authority,
        wallet.publicKey,
        [],
        amountIn
    ));

    // TODO: check order of the accounts
    // swap
    instructions.push(TokenSwap.swapInstruction(
        pool.pubkeys.program,
        authority,
        fromAccount,
        holdingA,
        holdingB,
        toAccount,
        programIds().swap,
        programIds().token,
        amountIn,
        minAmountOut,
    ));

    let tx = await sendTransaction(
        connection,
        wallet,
        instructions.concat(cleanupInstructions),
        signers);

    notify({
        message: 'Trade executed.',
        type: 'success',
        description: `Transaction - ${tx}`,
    });
};

export const addLiquidity = async (connection: Connection, wallet: any, components: LiquidityComponent[], pool?: PoolInfo) => {
    // TODO check if any of the accounts is native and needs to be wrapped?
    if (!pool) {
        await _addLiquidityNewPool(wallet, connection, components);
    } else {
        await _addLiquidityExistingPool(pool, components, connection, wallet);
    }
}



export const usePools = () => {
    const connection = useConnection();
    const { connected, wallet } = useWallet();
    const [pools, setPools] = useState<PoolInfo[]>([]);

    const getHoldings = (accounts: string[]) => {
        return accounts.map(acc => cache.getAccount(connection, new PublicKey(acc)));
    };

    useEffect(() => {
        const toPoolInfo = (item: any, toMerge?: PoolInfo) => {
            const mint = new PublicKey(item.data.tokenPool);
            return {
                pubkeys: {
                    program: item.pubkey,
                    mint,
                    accounts: [item.data.tokenAccountA, item.data.tokenAccountB]
                        .map(a => new PublicKey(a))
                },
                raw: item,
            } as PoolInfo;
        };

        const queryPools = async () => {
            const swapAccounts = (await connection.getProgramAccounts(programIds().swap))
                .filter(item => item.account.data.length === TokenSwapLayout.span)
                .map(item => {
                    return {
                        data: TokenSwapLayout.decode(item.account.data),
                        account: item.account,
                        pubkey: item.pubkey,
                    };
                });

            let result: PoolInfo[] = [];
            for (let i = 0; i < swapAccounts.length; i++) {
                const acc = swapAccounts[i];
                try {
                    // TODO: this is not great
                    // Ideally SwapLayout stores hash of all the mints to make finding of pool for a pair easier
                    const holdings = await Promise.all(getHoldings([acc.data.tokenAccountA, acc.data.tokenAccountB]));

                    if (holdings[0].info.amount.eqn(0)) {
                        continue;
                    }

                    let pool = toPoolInfo(acc);
                    pool.pubkeys.accountMints = [holdings[0].info.mint, holdings[1].info.mint] as PublicKey[];
                    result.push(pool);

                    await new Promise((resolve) => setTimeout(resolve, 500));
                } catch {

                }
            }

            setPools(result);
        };

        queryPools();

        const subID = connection.onProgramAccountChange(programIds().swap, async (info) => {
            const id = info.accountId as unknown as string;
            if (info.accountInfo.data.length === TokenSwapLayout.span) {
                const account = info.accountInfo;
                const updated = {
                    data: TokenSwapLayout.decode(account.data),
                    account: account,
                    pubkey: new PublicKey(id),
                };

                const index = pools.findIndex(p => p.pubkeys.program.toBase58() === id);
                if (index >= 0) {
                    // TODO: check if account is empty?

                    setPools([...pools.filter((p, i) => i !== index), toPoolInfo(updated)]);
                } else {
                    let pool = toPoolInfo(updated);

                    const holdings = await Promise.all(getHoldings([updated.data.tokenAccountA, updated.data.tokenAccountB]));
                    pool.pubkeys.accountMints = [holdings[0].info.mint, holdings[1].info.mint] as PublicKey[];

                    setPools([...pools, pool]);
                }
            }

        }, 'singleGossip');

        return () => {
            connection.removeProgramAccountChangeListener(subID);
        }
    }, [connected, connection, wallet?.publicKey])

    return { pools };
}

export const usePoolForBasket = (mints: (string | undefined)[]) => {
    const { pools } = useCachedPool();
    const sortedMints = mints.sort();

    return pools.find(p => p.pubkeys.accountMints.map(a => a.toBase58()).sort().every((address, i) => address === sortedMints[i]));
}

export const useOwnedPools = () => {
    const { pools } = useCachedPool();
    const { userAccounts } = useUserAccounts();

    const map = userAccounts.reduce((acc, item) => {
        const key = item.info.mint.toBase58();
        acc.set(key, item);
        return acc;
    }, new Map<string, TokenAccount>())

    return pools.filter(p => map.has(p.pubkeys.mint.toBase58())).map(item => {
        return {
            account: map.get(item.pubkeys.mint.toBase58()) as TokenAccount,
            pool: item,
        }
    });
};

async function _addLiquidityExistingPool(pool: PoolInfo, components: LiquidityComponent[], connection: Connection, wallet: any) {
    notify({
        message: 'Adding Liquidity...',
        description: 'Please review transactions to approve.',
        type: 'warn'
    });

    const poolMint = await cache.getMint(connection, pool.pubkeys.mint);
    if (!poolMint.mintAuthority) {
        throw new Error('Mint doesnt have authority')
    }


    const accountA = await cache.getAccount(connection, pool.pubkeys.accounts[0]);
    const accountB = await cache.getAccount(connection, pool.pubkeys.accounts[1]);

    const reserve0 = accountA.info.amount.toNumber();
    const reserve1 = accountB.info.amount.toNumber();
    const fromA = accountA.info.mint.toBase58() === components[0].account.info.mint.toBase58() ? components[0] : components[1];
    const fromB = fromA === components[0] ? components[1] : components[0];


    const supply = poolMint.supply.toNumber();
    const SLIPPAGE = 0.01; // 1% TODO: customize
    const authority = poolMint.mintAuthority;

    // Uniswap whitepaper: https://uniswap.org/whitepaper.pdf       
    // see: https://uniswap.org/docs/v2/advanced-topics/pricing/
    // as well as native uniswap v2 oracle: https://uniswap.org/docs/v2/core-concepts/oracles/
    const amount0 = fromA.amount; // these two should include slippage
    const amount1 = fromB.amount;

    // TODO:  calculate max slippage based on the serum dex price 
    const liquidity = Math.min(amount0 * (1 - SLIPPAGE) * supply / reserve0, amount1 * (1 - SLIPPAGE) * supply / reserve1);
    const instructions: TransactionInstruction[] = [];
    const cleanupInstructions: TransactionInstruction[] = [];

    const signers: Account[] = [];

    const accountRentExempt = await connection.getMinimumBalanceForRentExemption(AccountLayout.span);
    const fromKeyA = getWrappedAccount(instructions, cleanupInstructions, fromA.account, wallet.publicKey, amount0 + accountRentExempt, signers);
    const fromKeyB = getWrappedAccount(instructions, cleanupInstructions, fromB.account, wallet.publicKey, amount1 + accountRentExempt, signers);

    let toAccount = findOrCreateAccountByMint(
        connection,
        wallet.publicKey,
        wallet.publicKey,
        instructions,
        [],
        accountRentExempt,
        pool.pubkeys.mint,
        signers);

    // create approval for transfer transactions
    instructions.push(Token.createApproveInstruction(
        programIds().token,
        fromKeyA,
        authority,
        wallet.publicKey,
        [],
        amount0
    ));

    instructions.push(Token.createApproveInstruction(
        programIds().token,
        fromKeyB,
        authority,
        wallet.publicKey,
        [],
        amount1
    ));

    // depoist
    instructions.push(
        TokenSwap.depositInstruction(
            pool.pubkeys.program,
            authority,
            fromKeyA,
            fromKeyB,
            pool.pubkeys.accounts[0],
            pool.pubkeys.accounts[1],
            pool.pubkeys.mint,
            toAccount,
            programIds().swap,
            programIds().token,
            liquidity,
            amount0,
            amount1
        )
    );

    let tx = await sendTransaction(
        connection,
        wallet,
        instructions.concat(cleanupInstructions),
        signers);

    notify({
        message: 'Pool Funded. Happy trading.',
        type: 'success',
        description: `Transaction - ${tx}`,
    });
}

function findOrCreateAccountByMint(
    connection: Connection,
    payer: PublicKey,
    owner: PublicKey,
    instructions: TransactionInstruction[],
    cleanupInstructions: TransactionInstruction[],
    accountRentExempt: number,
    mint: PublicKey, // use to identify same type 
    signers: Account[]): PublicKey {
    const accountToFind = mint.toBase58();
    const account = getCachedAccount(acc => acc.info.mint.toBase58() === accountToFind && acc.info.owner.toBase58() === owner.toBase58());
    const isWrappedSol = accountToFind === WRAPPED_SOL_MINT.toBase58();

    let toAccount: PublicKey;
    if (account && !isWrappedSol) {
        toAccount = account.pubkey;
    } else {
        // creating depositor pool account
        const newToAccount = createSplAccount(
            instructions,
            payer,
            accountRentExempt,
            mint,
            owner,
            AccountLayout.span);

        toAccount = newToAccount.publicKey;
        signers.push(newToAccount);

        if (isWrappedSol) {
            cleanupInstructions.push(
                Token.createCloseAccountInstruction(
                    programIds().token,
                    toAccount,
                    payer,
                    payer,
                    [])
            );
        }
    }

    return toAccount;
}

export async function calculateDependentAmount(connection: Connection, independent: string, amount: number, pool: PoolInfo): Promise<number | undefined> {
    const poolMint = await cache.getMint(connection, pool.pubkeys.mint);
    const accountA = await cache.getAccount(connection, pool.pubkeys.accounts[0]);
    const accountB = await cache.getAccount(connection, pool.pubkeys.accounts[1]);
    if (!poolMint.mintAuthority) {
        throw new Error('Mint doesnt have authority')
    }


    if (poolMint.supply.eqn(0)) {
        return;
    }

    const mintA = await cache.getMint(connection, accountA.info.mint);
    const mintB = await cache.getMint(connection, accountB.info.mint);

    if (!mintA || !mintB) {
        return;
    }

    const isFirstIndependent = accountA.info.mint.toBase58() === independent;
    const depPrecision = Math.pow(10, isFirstIndependent ? mintB.decimals : mintA.decimals)
    const indPrecision = Math.pow(10, isFirstIndependent ? mintA.decimals : mintB.decimals)
    const adjAmount = amount * indPrecision;

    const dependentTokenAmount = isFirstIndependent
        ? accountB.info.amount.toNumber() / (accountA.info.amount).toNumber() * (adjAmount)
        : accountA.info.amount.toNumber() / (accountB.info.amount).toNumber() * (adjAmount)

    return dependentTokenAmount / depPrecision;
}

async function _addLiquidityNewPool(wallet: any, connection: Connection, components: LiquidityComponent[]) {
    notify({
        message: 'Creating new pool...',
        description: 'Please review transactions to approve.',
        type: 'warn'
    });

    // sets fee in the pool to 0.3%
    // see for fees details: https://uniswap.org/docs/v2/advanced-topics/fees/
    const feeNumerator = 3;
    const feeDenominator = 1000;

    let instructions: TransactionInstruction[] = [];
    let cleanupInstructions: TransactionInstruction[] = [];

    const liquidityTokenAccount = new Account();
    // Create account for pool liquidity token
    instructions.push(SystemProgram.createAccount({
        fromPubkey: wallet.publicKey,
        newAccountPubkey: liquidityTokenAccount.publicKey,
        lamports: await connection.getMinimumBalanceForRentExemption(MintLayout.span),
        space: MintLayout.span,
        programId: programIds().token,
    }));

    const tokenSwapAccount = new Account();

    const [authority, nonce] = await PublicKey.findProgramAddress(
        [tokenSwapAccount.publicKey.toBuffer()],
        programIds().swap);

    // create mint for pool liquidity token
    instructions.push(Token.createInitMintInstruction(
        programIds().token,
        liquidityTokenAccount.publicKey,
        LIQUIDITY_TOKEN_PRECISION,
        // pass control of liquidity mint to swap program
        authority,
        // swap program can freeze liquidity token mint
        authority)
    );

    // Create holding accounts for 
    const accountRentExempt = await connection.getMinimumBalanceForRentExemption(AccountLayout.span);
    const holdingAccounts: Account[] = [];
    let signers: Account[] = [];

    components.forEach(leg => {
        const mintPublicKey = leg.account.info.mint;
        // component account to store tokens I of N in liquidity poll
        holdingAccounts.push(
            createSplAccount(
                instructions,
                wallet.publicKey,
                accountRentExempt,
                mintPublicKey,
                authority,
                AccountLayout.span)
        );
    });

    // create all accounts in one transaction
    let tx = await sendTransaction(connection, wallet, instructions, [liquidityTokenAccount, ...holdingAccounts, ...signers]);

    notify({
        message: 'Accounts created',
        description: `Transaction ${tx}`,
        type: 'success'
    });

    notify({
        message: 'Adding Liquidity...',
        description: 'Please review transactions to approve.',
        type: 'warn'
    });

    signers = [];
    instructions = [];
    cleanupInstructions = [];

    instructions.push(SystemProgram.createAccount({
        fromPubkey: wallet.publicKey,
        newAccountPubkey: tokenSwapAccount.publicKey,
        lamports: await connection.getMinimumBalanceForRentExemption(TokenSwapLayout.span),
        space: TokenSwapLayout.span,
        programId: programIds().swap,
    }));

    components.forEach((leg, i) => {
        // create temporary account for wrapped sol to perform transfer
        const from = getWrappedAccount(instructions, cleanupInstructions, leg.account, wallet.publicKey, leg.amount + accountRentExempt, signers);

        instructions.push(Token.createTransferInstruction(
            programIds().token,
            from,
            holdingAccounts[i].publicKey,
            wallet.publicKey,
            [],
            leg.amount));
    });

    // creating depositor pool account
    const depositorAccount = createSplAccount(
        instructions,
        wallet.publicKey,
        accountRentExempt,
        liquidityTokenAccount.publicKey,
        wallet.publicKey,
        AccountLayout.span);

    instructions.push(createInitSwapInstruction(
        tokenSwapAccount,
        authority,
        nonce,
        holdingAccounts[0].publicKey,
        holdingAccounts[1].publicKey,
        liquidityTokenAccount.publicKey,
        depositorAccount.publicKey,
        programIds().token,
        programIds().swap,
        feeNumerator,
        feeDenominator
    ));

    // All instructions didn't fit in single transaction 
    // initialize and provide inital liquidity to swap in 2nd (this prevents loss of funds)
    tx = await sendTransaction(
        connection,
        wallet,
        instructions.concat(cleanupInstructions),
        [tokenSwapAccount, depositorAccount, ...signers]);

    notify({
        message: 'Pool Funded. Happy trading.',
        type: 'success',
        description: `Transaction - ${tx}`,
    });
}

function getWrappedAccount(instructions: TransactionInstruction[], cleanupInstructions: TransactionInstruction[], toCheck: TokenAccount, payer: PublicKey, amount: number, signers: Account[]) {
    if (!toCheck.info.isNative) {
        return toCheck.pubkey;
    }

    const account = new Account();
    instructions.push(SystemProgram.createAccount({
        fromPubkey: payer,
        newAccountPubkey: account.publicKey,
        lamports: amount,
        space: AccountLayout.span,
        programId: programIds().token,
    }));

    instructions.push(
        Token.createInitAccountInstruction(
            programIds().token,
            WRAPPED_SOL_MINT,
            account.publicKey,
            payer
        )
    );

    cleanupInstructions.push(
        Token.createCloseAccountInstruction(
            programIds().token,
            account.publicKey,
            payer,
            payer,
            [])
    );

    signers.push(account);

    return account.publicKey;
}

function createSplAccount(instructions: TransactionInstruction[], payer: PublicKey, accountRentExempt: number, mint: PublicKey, owner: PublicKey, space: number) {
    const account = new Account();
    instructions.push(SystemProgram.createAccount({
        fromPubkey: payer,
        newAccountPubkey: account.publicKey,
        lamports: accountRentExempt,
        space,
        programId: programIds().token,
    }));

    instructions.push(
        Token.createInitAccountInstruction(
            programIds().token,
            mint,
            account.publicKey,
            owner
        )
    );

    return account;
}
