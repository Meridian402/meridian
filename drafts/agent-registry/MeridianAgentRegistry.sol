// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

// ─────────────────────────────────────────────────────────────────────────────
// MeridianAgentRegistry: the on-chain identity of a Meridian agent.
//
// DRAFT · UNAUDITED · NOT DEPLOYED.
//
// A user's agent already exists off-chain, keyed to their wallet. This contract
// gives that identity a public, verifiable, transferable on-chain form: one
// minimal ERC-721 per wallet, minted by the user in their own wallet.
//
// WHAT THIS HOLDS: nothing. No ETH, no tokens, no positions, no keys. There is
// no receive, no fallback, no withdraw, no approval-of-funds, no signer. "The
// user keeps control of their funds" is therefore structural, not promised:
// there is nothing in this object to take. Losing or transferring the token
// hands over an identity badge and nothing else.
//
// WHAT THIS HAS NO LEVER FOR: there is no owner, no minter role, no pauser, no
// blocklist, no setTokenURI, no burn, and no upgrade path. Metadata is computed
// on-chain from immutable state, so it cannot be edited after the fact and needs
// no server. Same boring-on-purpose posture as MeridianToken.
//
// FORWARD COMPATIBILITY: this is deliberately the base layer for a later
// ERC-6551 token-bound account. That standard attaches an account to the tuple
// (chainId, this collection, tokenId) via the canonical registry and never
// calls back into this contract. Its only requirement of the base NFT is a
// correct, honest ownerOf at a permanent address with token ids that are fixed
// at mint and never recycled. This contract satisfies that with zero
// 6551-specific code, so an account attaches later with no re-mint and no
// migration of any identity already minted.
//
// THE 721 CORE IS INHERITED, NOT HAND-ROLLED. Unlike MeridianToken's ERC-20,
// the 721 approval and safe-transfer-callback semantics carry enough footguns
// that hand-rolling them would be the single largest correctness risk in this
// file. The core comes from OpenZeppelin v5; the only Meridian-specific surface
// an auditor must scrutinise is the mint path, the identity binding, and the
// on-chain tokenURI below.
// ─────────────────────────────────────────────────────────────────────────────

contract MeridianAgentRegistry is ERC721 {
    using Strings for uint256;
    using Strings for address;

    /// The wallet that minted a token. Immutable per token: set once at mint,
    /// never rewritten. The token id is derived from it, so this is also the
    /// on-chain proof of which wallet an identity was born to.
    mapping(uint256 tokenId => address wallet) public birthWallet;

    /// Creation time, in unix seconds, set once at mint. Feeds the immutable
    /// tokenURI so the identity's age is on-chain and cannot be backdated.
    mapping(uint256 tokenId => uint64 timestamp) public mintedAt;

    /// The immutable page an identity points at. Baked into bytecode on purpose:
    /// a mutable base URI would be a lever on presentation, which this contract
    /// refuses to have. The birth wallet is appended per token.
    string internal constant AGENT_PAGE_BASE = "https://meridian402.xyz/agent/";

    /// Domain-separated so an id from this collection can never collide with an
    /// id scheme from any future Meridian NFT.
    string internal constant ID_DOMAIN = "meridian.agent.identity.v1";

    error AlreadyMinted();
    error NonexistentToken();

    event AgentMinted(uint256 indexed tokenId, address indexed owner, uint64 mintedAt);

    constructor() ERC721("Meridian Agent", "MRDNAGENT") {}

    /// The token id a wallet's identity will have, deterministic and one-per-
    /// wallet. Pure, so the UI can show it and check ownerOf before any
    /// transaction, and so the future token-bound-account address is computable
    /// before this token even exists. Squatting is impossible: the id is bound
    /// to the wallet, so you can only ever mint your own.
    function tokenIdOf(address wallet) public pure returns (uint256) {
        return uint256(keccak256(abi.encodePacked(ID_DOMAIN, wallet)));
    }

    /// True once `wallet` has minted its identity.
    function isMinted(address wallet) external view returns (bool) {
        return _ownerOf(tokenIdOf(wallet)) != address(0);
    }

    /// Mint the caller's own agent identity. No arguments, no signer, no admin:
    /// the id is derived from msg.sender, so this can only mint the caller's own
    /// identity, exactly once. Reverts if it already exists.
    function mint() external returns (uint256 tokenId) {
        tokenId = tokenIdOf(msg.sender);
        if (_ownerOf(tokenId) != address(0)) revert AlreadyMinted();
        birthWallet[tokenId] = msg.sender;
        mintedAt[tokenId] = uint64(block.timestamp);
        // _safeMint so a contract wallet that cannot receive a 721 fails loudly
        // at mint rather than stranding an unusable identity. A smart-account
        // minter must therefore implement onERC721Received (documented tradeoff).
        _safeMint(msg.sender, tokenId);
        emit AgentMinted(tokenId, msg.sender, uint64(block.timestamp));
    }

    /// Fully on-chain, immutable metadata. Pure identity only: a stable name, the
    /// immutable creation date, the birth wallet, and a pointer to the agent's
    /// live page for mutable presentation (display name, persona) that must never
    /// be a lever on this token. Carries nothing private and nothing about the
    /// desk's performance.
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        address minter = birthWallet[tokenId];
        if (minter == address(0)) revert NonexistentToken();

        // Name is keyed to the birth wallet, which is 1:1 with the identity, so
        // the human-facing name is as unique as the token id it labels (a
        // truncated numeric id could collide across agents). No `image` field is
        // set on purpose: this is a pure identity anchor, and any thumbnail
        // belongs on the mutable off-chain page, not baked into the token.
        string memory json = string.concat(
            '{"name":"Meridian Agent ',
            minter.toHexString(),
            '","description":"The on-chain identity of a Meridian sovereign agent on Robinhood Chain. This token holds no assets and no keys; it is an identity, not a wallet.",',
            '"external_url":"',
            AGENT_PAGE_BASE,
            minter.toHexString(),
            '","attributes":[',
            '{"display_type":"date","trait_type":"Created","value":',
            uint256(mintedAt[tokenId]).toString(),
            '},{"trait_type":"Birth wallet","value":"',
            minter.toHexString(),
            '"}]}'
        );

        return string.concat("data:application/json;base64,", Base64.encode(bytes(json)));
    }

    // Deliberately absent: receive(), fallback(), any payable function, any
    // withdraw, any owner or admin, any setTokenURI, any burn, any upgrade.
    // This contract can only mint an identity to its caller and read it back.
}
