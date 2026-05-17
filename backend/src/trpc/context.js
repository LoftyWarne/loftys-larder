export function createContext({ req, res }) {
    return {
        req,
        reply: res,
        reqId: req.id,
        // FEAT-14 insertion point: resolve the authenticated session here before
        // returning. Until then every request is anonymous.
        session: null,
    };
}
//# sourceMappingURL=context.js.map