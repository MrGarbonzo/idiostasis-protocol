// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Script.sol";
import "../src/IdiostasisRegistry.sol";

contract Deploy is Script {
    function run() external {
        vm.startBroadcast();
        IdiostasisRegistry registry = new IdiostasisRegistry();
        console.log("IdiostasisRegistry deployed at:", address(registry));
        vm.stopBroadcast();
    }
}
