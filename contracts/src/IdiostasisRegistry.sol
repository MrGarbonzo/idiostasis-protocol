// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";

/**
 * @title IdiostasisRegistry
 * @notice ERC-721-based registry for TEE-attested agents and guardians.
 *         Each registered entity receives a non-transferable NFT that anchors
 *         its on-chain identity (endpoint, TEE measurements, ed25519 pubkey).
 */
contract IdiostasisRegistry is ERC721 {
    // ── Types ────────────────────────────────────────────────────────

    struct RegistryEntry {
        uint8 entityType;        // 0 = agent, 1 = guardian
        string endpoint;
        bytes16 teeInstanceId;
        bytes32 codeHash;
        bytes32 attestationHash;
        bytes32 ed25519Pubkey;
        uint256 registeredAt;
        uint256 lastHeartbeat;
        bool isActive;
        address owner;
    }

    // ── Events ───────────────────────────────────────────────────────

    event Registered(uint256 indexed tokenId, address indexed owner, uint8 entityType);
    event Heartbeat(uint256 indexed tokenId, uint256 timestamp);
    event EndpointUpdated(uint256 indexed tokenId, string newEndpoint);
    event Deactivated(uint256 indexed tokenId);

    // ── Storage ──────────────────────────────────────────────────────

    uint256 private _nextTokenId;
    mapping(uint256 => RegistryEntry) private _entries;
    mapping(address => uint256) private _ownerToken;
    mapping(address => bool) private _hasRegistered;

    // ── Constructor ──────────────────────────────────────────────────

    constructor() ERC721("IdiostasisRegistry", "IDIO") {}

    // ── Write Operations ─────────────────────────────────────────────

    /**
     * @notice Register a new entity. Mints an NFT and stores the entry.
     *         One registration per address; reverts if already registered.
     */
    function register(
        uint8 entityType,
        string calldata endpoint,
        bytes16 teeInstanceId,
        bytes32 codeHash,
        bytes32 attestationHash,
        bytes32 ed25519Pubkey
    ) external returns (uint256 tokenId) {
        require(!_hasRegistered[msg.sender], "Already registered");

        tokenId = _nextTokenId++;
        _mint(msg.sender, tokenId);

        _entries[tokenId] = RegistryEntry({
            entityType: entityType,
            endpoint: endpoint,
            teeInstanceId: teeInstanceId,
            codeHash: codeHash,
            attestationHash: attestationHash,
            ed25519Pubkey: ed25519Pubkey,
            registeredAt: block.timestamp,
            lastHeartbeat: block.timestamp,
            isActive: true,
            owner: msg.sender
        });

        _ownerToken[msg.sender] = tokenId;
        _hasRegistered[msg.sender] = true;

        emit Registered(tokenId, msg.sender, entityType);
    }

    /**
     * @notice Update the lastHeartbeat timestamp. Owner only.
     */
    function heartbeat(uint256 tokenId) external {
        require(ownerOf(tokenId) == msg.sender, "Not owner");
        _entries[tokenId].lastHeartbeat = block.timestamp;
        emit Heartbeat(tokenId, block.timestamp);
    }

    /**
     * @notice Update the endpoint for an entry. Owner only.
     */
    function updateEndpoint(uint256 tokenId, string calldata newEndpoint) external {
        require(ownerOf(tokenId) == msg.sender, "Not owner");
        _entries[tokenId].endpoint = newEndpoint;
        emit EndpointUpdated(tokenId, newEndpoint);
    }

    /**
     * @notice Deactivate an entry. Owner only.
     */
    function deactivate(uint256 tokenId) external {
        require(ownerOf(tokenId) == msg.sender, "Not owner");
        _entries[tokenId].isActive = false;
        emit Deactivated(tokenId);
    }

    // ── Read Operations ──────────────────────────────────────────────

    /**
     * @notice Get the full entry for a token.
     */
    function getEntry(uint256 tokenId)
        external
        view
        returns (
            uint8 entityType,
            string memory endpoint,
            bytes16 teeInstanceId,
            bytes32 codeHash,
            bytes32 attestationHash,
            bytes32 ed25519Pubkey,
            uint256 registeredAt,
            uint256 lastHeartbeat,
            bool isActive,
            address owner
        )
    {
        // Revert if token doesn't exist (ownerOf reverts for non-existent tokens)
        ownerOf(tokenId);

        RegistryEntry storage e = _entries[tokenId];
        return (
            e.entityType,
            e.endpoint,
            e.teeInstanceId,
            e.codeHash,
            e.attestationHash,
            e.ed25519Pubkey,
            e.registeredAt,
            e.lastHeartbeat,
            e.isActive,
            e.owner
        );
    }

    /**
     * @notice Get the tokenId for an owner address. Reverts if not registered.
     */
    function getTokenByOwner(address owner) external view returns (uint256 tokenId) {
        require(_hasRegistered[owner], "Not registered");
        return _ownerToken[owner];
    }

    /**
     * @notice Get all active tokenIds of a given entity type.
     */
    function getActiveByType(uint8 entityType) external view returns (uint256[] memory tokenIds) {
        // Count active entries of this type
        uint256 count = 0;
        for (uint256 i = 0; i < _nextTokenId; i++) {
            if (_entries[i].isActive && _entries[i].entityType == entityType) {
                count++;
            }
        }

        // Collect them
        tokenIds = new uint256[](count);
        uint256 idx = 0;
        for (uint256 i = 0; i < _nextTokenId; i++) {
            if (_entries[i].isActive && _entries[i].entityType == entityType) {
                tokenIds[idx++] = i;
            }
        }
    }
}
