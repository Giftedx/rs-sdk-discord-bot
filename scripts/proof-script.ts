// Copied from rs-sdk bots/_template/script.ts at commit 3506b20.
// Copyright (c) 2025 Lost City. MIT License. See THIRD_PARTY_NOTICES.md.
// Changes: this header and the import path.
// scripts/proxy-proof.ts runs this file to show that unchanged SDK code works through the proxy.
import { runScript } from '../vendor/rs-sdk/sdk/runner';

await runScript(async (ctx) => {
    const { bot, sdk } = ctx;

    // Skip tutorial if active
    await bot.skipTutorial();

    // === YOUR SCRIPT LOGIC BELOW ===

    // Example: chop a tree
    const tree = sdk.findNearbyLoc(/^tree$/i);
    if (tree) {
        console.log(`Found tree at (${tree.x}, ${tree.z})`);
        const result = await bot.chopTree(tree);
        console.log(result.message);
    }

    // === END SCRIPT LOGIC ===

}, {
    timeout: 60_000,  // 1 minute timeout
});
