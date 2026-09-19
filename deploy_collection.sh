#!/usr/bin/env bash
# Deploy the genesis FlyCollection on top of a mesh that deploy.sh already put on <network>, list it on that mesh's
# CollectionWhitelist (when the deployer is its curator), and record it in .env.<network> as PORW_COLLECTION.
#   NETWORK=bsc-testnet BASE_MEP_FEMALE=0x... ./deploy_collection.sh [extra forge args]
# The genesis set is read from flybnb/genesis/genesis-v1.json -- it is not a parameter. Prices default to the mainnet
# intent (0.1 / 0.05 bond / 0.05 breed / 0.001 bounty BNB, 10% royalty); override MINT_PRICE, MINT_BOND, BREED_FEE,
# HATCH_BOUNTY (wei) and ROYALTY_BPS for a network whose UNIT is smaller. BASE_VENDOR (default: the treasury) takes BASE_SHARE_BPS
# (1000: a tenth) of every royalty; SALE_ROYALTY_BPS (500) is what ERC-2981 asks of a resale, to the treasury; OWNER (default:
# the deployer) is `owner()` for marketplaces and can only choose the token renderer, which this deploys and sets.
# TREASURY is IMMUTABLE in the collection. Unless one is named, a TreasuryRouter is deployed and used: a fixed address whose
# destination can change (TREASURY_OWNER chooses it, in two-step hands; TREASURY_DESTINATION is where it forwards; both default
# to the deployer -- on a network that matters, make them a multisig). Its address is saved as PORW_TREASURY.
set -euo pipefail
cd "$(dirname "$0")"
NET="${NETWORK:?set NETWORK (the one deploy.sh was run with)}"; ENVF=".env.$NET"; [ -f "$ENVF" ] || { echo "missing $ENVF: run deploy.sh first"; exit 1; }
: "${BASE_MEP_FEMALE:?set BASE_MEP_FEMALE (the registered base brain: what adopters are bonded for)}"
set -a; . "./$ENVF"; set +a
export MEPS="$PORW_MEP_REGISTRY" INSTANCES="$PORW_INSTANCES" MARKET="$PORW_MARKET" WHITELIST="${PORW_WHITELIST:-0x0000000000000000000000000000000000000000}"
OUT="$(cd contracts && forge script script/DeployCollection.s.sol --rpc-url "$PORW_RPC" --chain-id "$PORW_CHAIN_ID" --private-key "$PORW_DEPLOYER_KEY" --broadcast "$@" 2>&1)" || { echo "$OUT" | grep -v -i "private" | tail -30; exit 1; }
echo "$OUT" | grep -E "^  (collection|treasury router|renderer|genesis size|listed|0x)" || true
ADDR="$(echo "$OUT" | awk '/^  collection /{print $2}' | tail -1)"; [ -n "$ADDR" ] || { echo "could not read the collection's address from the script output"; exit 1; }
TRE="$(echo "$OUT" | awk '/^  treasury router /{print $3}' | tail -1)"
# a collection is never replaced, only succeeded: the one this file named before stays in it, as a comment
PREV="$(grep '^PORW_COLLECTION=' "$ENVF" | cut -d= -f2- || true)"
grep -v -E '^PORW_(COLLECTION|TREASURY)=' "$ENVF" > "$ENVF.tmp"
{ [ -n "$PREV" ] && [ "$PREV" != "$ADDR" ] && echo "# previous collection: $PREV"; echo "PORW_COLLECTION=$ADDR"; [ -n "$TRE" ] && echo "PORW_TREASURY=$TRE"; true; } >> "$ENVF.tmp"
mv "$ENVF.tmp" "$ENVF" && chmod 600 "$ENVF"
echo "PORW_COLLECTION=$ADDR${TRE:+ PORW_TREASURY=$TRE} saved to $ENVF"
