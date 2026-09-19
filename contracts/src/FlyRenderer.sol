// SPDX-License-Identifier: 0BSD
pragma solidity ^0.8.20;

import "./FlyCollection.sol";

/// @title FlyRenderer — what a fly looks like to a marketplace, entirely on-chain
/// @notice `FlyCollection.tokenURI` delegates here. The metadata is a `data:` URI built from the collection's own public
///         state, so there is no server to keep alive and nothing that can be swapped behind a token's back except by the
///         collection's owner pointing at another renderer -- the one power that owner has.
///
///         The picture is an identicon and nothing more: a fly's head seen from the front, two red compound eyes and a
///         brain whose neurons are placed by the individual's hash, mirrored because a fly brain is bilateral. The eyes are
///         always wild-type red and NOTHING here varies with "rarity": what a brain is gets measured by experiments against
///         it, and a picture that hinted otherwise would be the one dishonest thing about the token. The attributes are
///         facts of the pedigree (sex, generation, parents, stage) and nothing else. An egg is drawn as an egg: until it
///         hatches it has no seed, so there is nothing to draw a brain from.
contract FlyRenderer is ITokenRenderer {
    function tokenURI(address collection, uint256 id) external view returns (string memory) {
        FlyCollection c = FlyCollection(payable(collection));
        (, bytes32 deltaHash, bytes32 modelId, bytes32 mepId, uint8 sex, uint32 generation, uint64 parentA, uint64 parentB, bytes32 seed,) = c.individuals(id);
        bool egg = sex == c.UNHATCHED();
        string memory stage = egg ? "egg" : mepId != bytes32(0) ? "registered" : modelId != bytes32(0) ? "claimed" : "hatched";
        bytes memory attrs = abi.encodePacked(
            '{"trait_type":"Sex","value":"', egg ? "unknown" : sex == c.FEMALE() ? "female" : "male", '"},',
            '{"trait_type":"Generation","display_type":"number","value":', _u(generation), '},',
            '{"trait_type":"Stage","value":"', stage, '"}');
        if (parentA != 0) attrs = abi.encodePacked(attrs, ',{"trait_type":"Dam","value":"#', _u(parentA), '"},{"trait_type":"Sire","value":"#', _u(parentB), '"}');
        else attrs = abi.encodePacked(attrs, ',{"trait_type":"Founder","value":"yes"}');
        bytes memory json = abi.encodePacked(
            '{"name":"Fly #', _u(id), '","description":"A fruit-fly brain individual: an edit of a released connectome, hosted and run on a proof-of-resident-weights mesh. Its worth is what experiments have measured about it.",',
            '"attributes":[', attrs, '],"image":"data:image/svg+xml;base64,', _b64(_svg(egg, keccak256(abi.encode(deltaHash, seed, id)))), '"}');
        return string(abi.encodePacked("data:application/json;base64,", _b64(json)));
    }

    // paper, gold, blush, sage: the grounds the page's portraits use
    function _ground(uint8 k) private pure returns (string memory a, string memory b) {
        k = k % 4; if (k == 0) return ("#fff4cc", "#fde8eb"); if (k == 1) return ("#faf5e9", "#ffe9a8"); if (k == 2) return ("#e9f3ee", "#fff4cc"); return ("#fde8eb", "#faf5e9");
    }
    function _svg(bool egg, bytes32 h) private pure returns (bytes memory) {
        (string memory g0, string memory g1) = _ground(uint8(h[31]));
        bytes memory head = abi.encodePacked('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 190"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="', g0, '"/><stop offset="1" stop-color="', g1, '"/></linearGradient></defs><rect width="200" height="190" fill="url(#g)"/>');
        if (egg) return abi.encodePacked(head, '<ellipse cx="100" cy="168" rx="40" ry="6" fill="#1b1a17" opacity=".08"/><ellipse cx="100" cy="100" rx="42" ry="58" fill="#fff6dc" stroke="#1b1a17" stroke-opacity=".28" stroke-width="1.5"/><ellipse cx="86" cy="76" rx="9" ry="15" fill="#fff" opacity=".8" transform="rotate(-18 86 76)"/></svg>');
        bytes memory dots;
        for (uint256 k = 0; k < 12; k++) { // twelve neurons in the left half, mirrored
            uint256 x = 94 - uint8(h[2 * k]) % 26; uint256 y = 72 + uint8(h[2 * k + 1]) % 50; uint256 r = 2 + (uint8(h[2 * k]) >> 6);
            dots = abi.encodePacked(dots, '<circle cx="', _u(x), '" cy="', _u(y), '" r="', _u(r), '"/><circle cx="', _u(200 - x), '" cy="', _u(y), '" r="', _u(r), '"/>');
        }
        return abi.encodePacked(head,
            '<ellipse cx="100" cy="172" rx="70" ry="6" fill="#1b1a17" opacity=".07"/><ellipse cx="100" cy="98" rx="66" ry="54" fill="#fffdf8" stroke="#1b1a17" stroke-opacity=".1"/>',
            '<path d="M100 54C66 54 54 78 56 100C58 126 78 140 100 140C122 140 142 126 144 100C146 78 134 54 100 54Z" fill="#f0b90b"/><path d="M100 56L100 138" stroke="#1b1a17" stroke-opacity=".18"/>',
            '<g fill="#1b1a17">', dots, '</g><ellipse cx="36" cy="96" rx="27" ry="42" fill="#d7263d"/><ellipse cx="164" cy="96" rx="27" ry="42" fill="#d7263d"/>',
            '<ellipse cx="28" cy="74" rx="6" ry="11" fill="#fff" opacity=".35" transform="rotate(-20 28 74)"/><ellipse cx="172" cy="74" rx="6" ry="11" fill="#fff" opacity=".35" transform="rotate(20 172 74)"/></svg>');
    }

    function _u(uint256 v) private pure returns (string memory) {
        if (v == 0) return "0"; uint256 n; for (uint256 t = v; t != 0; t /= 10) n++;
        bytes memory b = new bytes(n); while (v != 0) { b[--n] = bytes1(uint8(48 + v % 10)); v /= 10; } return string(b);
    }
    bytes private constant ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    /// RFC 4648 base64, padded. Plain Solidity: this runs in an eth_call, and being readable is worth more than the gas.
    function _b64(bytes memory data) private pure returns (bytes memory out) {
        bytes memory t = ALPHABET; uint256 n = data.length; out = new bytes(4 * ((n + 2) / 3)); uint256 j;
        unchecked { for (uint256 i = 0; i < n; i += 3) {
            uint256 a = uint8(data[i]); uint256 b = i + 1 < n ? uint8(data[i + 1]) : 0; uint256 c = i + 2 < n ? uint8(data[i + 2]) : 0; uint256 w = (a << 16) | (b << 8) | c;
            out[j++] = t[(w >> 18) & 63]; out[j++] = t[(w >> 12) & 63]; out[j++] = i + 1 < n ? t[(w >> 6) & 63] : bytes1("="); out[j++] = i + 2 < n ? t[w & 63] : bytes1("=");
        } }
    }
}
