// public/gfg-explorer.js
// Shared on-chain explorer link helper (devnet).
//
// Why SolanaFM: for devnet txs, explorer.solana.com frequently shows "Transaction
// not found" for minutes after a tx lands (their devnet indexer lags). SolanaFM
// runs its own indexer, catches custom-program data faster, and supports the
// devnet cluster directly. We expose a PRIMARY link (SolanaFM) and a FALLBACK
// link (official Solana explorer) so users always have a second place to verify.
//
// Usage (plain <script> global, no module):
//   window.gfgExplorer.txLink(signature, label?) -> <a>...</a> (primary+fallback)
//   window.gfgExplorer.txUrl(signature)           -> SolanaFM devnet tx URL
//   window.gfgExplorer.accountLink(address, label?)
//   window.gfgExplorer.accountUrl(address)
//   window.gfgExplorer.txLinkPlain(signature, label) -> primary-only URL
(function () {
    const TX_BASE = 'https://solana.fm/tx/';
    const ACCOUNT_BASE = 'https://solana.fm/address/';
    const CLUSTER = '?cluster=devnet-solana';
    const FALLBACK_TX = 'https://explorer.solana.com/tx/';
    const FALLBACK_CLUSTER = '?cluster=devnet';

    function short(id, n) {
        if (!id) return '';
        n = n || 8;
        return id.length > 2 * n ? id.slice(0, n) + '…' + id.slice(-n) : id;
    }

    window.gfgExplorer = {
        txUrl: (sig) => (sig ? TX_BASE + sig + CLUSTER : null),
        accountUrl: (addr) => (addr ? ACCOUNT_BASE + addr + CLUSTER : null),

        // Clickable tx link with a primary (SolanaFM) + fallback (Solana
        // explorer) anchor, opened in a new tab. Returns '' for empty input.
        txLink: (sig, label) => {
            if (!sig) return '';
            const text = label || short(sig);
            const fm = window.gfgExplorer.txUrl(sig);
            const off = FALLBACK_TX + sig + FALLBACK_CLUSTER;
            return `<a href="${fm}" target="_blank" rel="noopener noreferrer" style="color:#f87818;text-decoration:underline;word-break:break-all;">${text} 🔗</a> ` +
                   `<a href="${off}" target="_blank" rel="noopener noreferrer" style="color:#7838f8;text-decoration:underline;font-size:0.8em;">(alt)</a>`;
        },

        // Clickable account/wallet link (SolanaFM primary + alt).
        accountLink: (addr, label) => {
            if (!addr) return '';
            const text = label || short(addr);
            const fm = window.gfgExplorer.accountUrl(addr);
            const off = 'https://explorer.solana.com/address/' + addr + FALLBACK_CLUSTER;
            return `<a href="${fm}" target="_blank" rel="noopener noreferrer" style="color:#9bd4ff;text-decoration:underline;word-break:break-all;">${text} 🔗</a> ` +
                   `<a href="${off}" target="_blank" rel="noopener noreferrer" style="color:#7838f8;text-decoration:underline;font-size:0.8em;">(alt)</a>`;
        },
    };
})();
