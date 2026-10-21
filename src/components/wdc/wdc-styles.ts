// Warp Dust Crusaders coach board styles, ported from the prototype
// (warp-dust-crusaders-site/source/teo8-2026-10/board-template.html). This is the TEAM look (dark
// ground, warp magenta, Saira + Barlow). Every rule lives under .wdc; the page shell (index.html)
// only sets the html/body ground and the root fills the screen itself. Tokens: dark first, light
// when the device asks for it.
export const WDC_CSS = `
.wdc{
  color-scheme:dark;
  --ground:#2f2e33; --deep:#232227; --panel:#38363d; --panel-2:#413e47;
  --ink:#f2eff6; --ink-soft:#c9c4d3; --ink-mute:#8e889b; --rule:#4a4752;
  --warp:#e04dff; --warp-soft:rgba(224,77,255,.16); --good:#6fcf8e; --bad:#f08a6a; --draw:#f2c94c;
  --display:"Saira","Arial Narrow","Helvetica Neue",Arial,sans-serif;
  --body:"Barlow","Helvetica Neue",Arial,sans-serif;
  position:relative;min-height:100vh;box-sizing:border-box;background:var(--ground);color:var(--ink);
  font-family:var(--body);font-size:16px;line-height:1.35;padding:12px 16px 24px;-webkit-text-size-adjust:100%;
}
@media (prefers-color-scheme:light){.wdc{
  color-scheme:light; --ground:#f3f1f6; --deep:#e6e2ec; --panel:#ffffff; --panel-2:#f7f5fa;
  --ink:#1d1b22; --ink-soft:#4a4752; --ink-mute:#7a7487; --rule:#d7d2df;
  --warp:#b41fd6; --warp-soft:rgba(180,31,214,.12); --good:#1f8f4c; --bad:#c7502c; --draw:#b58a00;}}
.wdc *,.wdc *::before,.wdc *::after{box-sizing:border-box}
.wdc h1,.wdc h2,.wdc h3,.wdc p{margin:0}
.wdc h1,.wdc h2,.wdc h3{font-family:var(--display);text-wrap:balance}
.wdc button{font:inherit;color:inherit;background:none;border:0;padding:0;cursor:pointer;touch-action:manipulation}
.wdc button:disabled{cursor:default}
.wdc button:focus-visible,.wdc a:focus-visible,.wdc input:focus-visible,.wdc select:focus-visible{outline:2px solid var(--warp);outline-offset:2px}
.wdc .num{font-variant-numeric:tabular-nums}
.wdc .eyebrow{font-family:var(--display);font-weight:700;font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--ink-mute)}
.wdc .app{display:block}

/* header */
.wdc .top{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:10px 16px;max-width:1180px;margin:0 auto}
.wdc .top h1{font-size:clamp(22px,3.2vw,30px);font-weight:900;letter-spacing:.02em;text-transform:uppercase;line-height:1}
.wdc .top h1 span{color:var(--warp)}
.wdc .rounds{display:flex;gap:6px;flex-wrap:wrap}
.wdc .rounds button{min-width:44px;min-height:44px;padding:0 14px;border:1px solid var(--rule);border-radius:999px;font-family:var(--display);font-weight:700;font-size:15px;color:var(--ink-soft)}
.wdc .rounds button[aria-current="true"]{background:var(--warp);border-color:var(--warp);color:#fff}
.wdc .rounds button:disabled{opacity:.35}
.wdc .views{display:inline-flex;border:1px solid var(--rule);border-radius:999px;padding:3px;gap:3px}
.wdc .views button{min-height:44px;padding:0 16px;border-radius:999px;font-family:var(--display);font-weight:700;font-size:14px;color:var(--ink-soft)}
.wdc .views button[aria-current="true"]{background:var(--panel);color:var(--ink);box-shadow:inset 0 0 0 1px var(--warp)}
.wdc .hdr-r{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.wdc .stale{max-width:1180px;margin:8px auto 0;font-size:13px;color:var(--draw)}

/* team strip */
.wdc .strip{max-width:1180px;margin:14px auto 0;background:var(--deep);border:1px solid var(--rule);border-radius:14px;padding:14px 16px;display:grid;grid-template-columns:1.4fr 1fr 1fr 1fr;gap:12px 20px;align-items:center}
.wdc .strip .vs{grid-column:1/-1;display:flex;flex-wrap:wrap;align-items:baseline;gap:6px 14px}
.wdc .strip .vs h2{font-size:clamp(18px,2.6vw,24px);font-weight:700;letter-spacing:.01em}
.wdc .strip .vs .oppelo{color:var(--ink-mute);font-size:14px}
.wdc .stat{min-width:0}
.wdc .stat .lab{font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:var(--ink-mute);font-family:var(--display);font-weight:700}
.wdc .stat .val{font-family:var(--display);font-weight:900;font-size:clamp(26px,4vw,38px);line-height:1;margin-top:2px}
.wdc .stat .sub{font-size:13px;color:var(--ink-soft);margin-top:4px}
.wdc .tag{display:inline-block;padding:2px 9px;border-radius:999px;font-family:var(--display);font-weight:700;font-size:12px;letter-spacing:.08em;text-transform:uppercase;vertical-align:middle}
.wdc .tag.lead{margin-left:8px}
.wdc .tag.win{background:rgba(111,207,142,.18);color:var(--good)}
.wdc .tag.loss{background:rgba(240,138,106,.18);color:var(--bad)}
.wdc .tag.draw{background:rgba(242,201,76,.18);color:var(--draw)}
.wdc .tag.open{background:var(--warp-soft);color:var(--warp)}
.wdc .need{grid-column:1/-1;border-top:1px solid var(--rule);padding-top:10px;display:flex;flex-wrap:wrap;gap:8px 22px;font-size:15px;color:var(--ink-soft)}
.wdc .need b{color:var(--ink);font-family:var(--display);font-weight:700}
@media (max-width:720px){.wdc .strip{grid-template-columns:1fr 1fr}}

/* table cards */
.wdc .grid{max-width:1180px;margin:14px auto 0;display:grid;grid-template-columns:repeat(auto-fill,minmax(270px,1fr));gap:12px}
.wdc .card{position:relative;background:var(--panel);border:1px solid var(--rule);border-radius:14px;padding:12px 12px 10px;display:grid;grid-template-columns:1fr auto;gap:8px 10px;min-width:0;text-align:left;width:100%;transition:transform .12s ease,border-color .12s ease;cursor:pointer}
.wdc .card:active{transform:scale(.985)}
.wdc .card.scored{border-color:var(--warp)}
.wdc .card.posted{cursor:default}
.wdc .card .tno{grid-column:1/-1;display:flex;align-items:center;justify-content:space-between;gap:8px}
.wdc .card .tno .eyebrow{color:var(--warp)}
.wdc .side{min-width:0}
.wdc .side .who{font-family:var(--display);font-weight:700;font-size:18px;line-height:1.1;overflow-wrap:anywhere}
.wdc .side .meta{font-size:13px;color:var(--ink-soft);margin-top:3px;display:flex;flex-wrap:wrap;gap:2px 8px}
.wdc .side .meta .elo{color:var(--ink);font-weight:600}
.wdc .side .meta .elo.unk{color:var(--ink-mute);font-weight:400}
.wdc .side.them .who{color:var(--ink-soft)}
.wdc .score{grid-column:2;grid-row:2/4;align-self:center;display:flex;flex-direction:column;align-items:center;justify-content:center;min-width:92px;min-height:88px;border-radius:12px;background:var(--panel-2);border:1px dashed var(--rule)}
.wdc .card.scored .score{border-style:solid;border-color:var(--warp);background:var(--warp-soft)}
.wdc .score .big{font-family:var(--display);font-weight:900;font-size:40px;line-height:1}
.wdc .score .big.fc{color:var(--ink-mute)}
.wdc .score .big small{font-size:18px;color:var(--ink-mute);font-weight:700}
.wdc .score .lab{font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-mute);font-family:var(--display);font-weight:700}
.wdc .pred{grid-column:1/-1;display:flex;align-items:center;gap:10px;font-size:13px;color:var(--ink-soft);border-top:1px solid var(--rule);padding-top:8px}
.wdc .pred .bar{flex:1;height:6px;border-radius:3px;background:var(--rule);overflow:hidden;min-width:60px}
.wdc .pred .bar i{display:block;height:100%;background:var(--warp)}
.wdc .pred b{color:var(--ink);font-family:var(--display)}
/* the score never splits across lines ("12-" then "8" on phones) */
.wdc .pred b{white-space:nowrap}
@media (max-width:560px){.wdc .listlink{white-space:nowrap}}
.wdc .listlink{display:inline-flex;align-items:center;gap:4px;min-height:44px;padding:0 12px;border:1px solid var(--rule);border-radius:999px;font-family:var(--display);font-weight:700;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--ink);text-decoration:none;background:var(--panel-2)}
.wdc .listlink.them{border-color:var(--warp);color:var(--warp)}
.wdc .listlink.none{opacity:.45;pointer-events:none}
.wdc .nudge{display:inline-flex;gap:4px;margin-left:auto}
.wdc .nudge button{min-width:44px;min-height:44px;border:1px solid var(--rule);border-radius:8px;font-family:var(--display);font-weight:700;font-size:18px;background:var(--panel-2)}

/* pairing view */
.wdc .pair{max-width:1180px;margin:12px auto 0;display:flex;flex-direction:column;gap:10px;min-height:0}
.wdc .pair .bar{display:flex;flex-wrap:wrap;align-items:center;gap:8px 14px;background:var(--deep);border:1px solid var(--rule);border-radius:12px;padding:10px 14px}
.wdc .pair .bar label{font-family:var(--display);font-weight:700;font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:var(--ink-mute)}
.wdc .pair select{min-height:44px;padding:0 10px;border:1px solid var(--rule);border-radius:8px;background:var(--panel);color:var(--ink);font:inherit;font-weight:600;max-width:100%}
.wdc .pair .bar .sum{margin-left:auto;display:flex;flex-wrap:wrap;gap:6px 14px;align-items:center;font-size:14px;color:var(--ink-soft)}
.wdc .pair .bar .sum b{font-family:var(--display);font-size:20px;color:var(--ink)}
.wdc .pair .bar .go{min-height:44px;padding:0 16px;border-radius:999px;background:var(--warp);color:#fff;font-family:var(--display);font-weight:700;font-size:14px;letter-spacing:.04em}
.wdc .pair .bar .go:disabled{opacity:.4}
.wdc .pair .bar .reset,.wdc .pair .bar .showall{min-height:44px;padding:0 14px;border:1px solid var(--rule);border-radius:999px;font-family:var(--display);font-weight:700;font-size:13px;color:var(--ink-soft)}
.wdc .pair .bar .reset{color:var(--bad)}
.wdc .pair .bar .showall[aria-pressed="true"]{border-color:var(--warp);color:var(--warp)}
.wdc .mwrap{overflow:auto;min-height:0;border:1px solid var(--rule);border-radius:12px;background:var(--panel)}
.wdc .matrix{border-collapse:separate;border-spacing:0;width:100%;table-layout:fixed;min-width:860px}
.wdc .matrix th,.wdc .matrix td{padding:0;border-bottom:1px solid var(--rule);border-right:1px solid var(--rule);vertical-align:top}
.wdc .matrix th{background:var(--deep);text-align:left;font-weight:600}
.wdc .matrix thead th{position:sticky;top:0;z-index:2}
.wdc .matrix tbody th{position:sticky;left:0;z-index:1;width:150px}
.wdc .matrix thead th:first-child{left:0;z-index:3;width:150px}
.wdc .ph{display:flex;flex-direction:column;gap:2px;padding:7px 8px;min-width:0}
.wdc .ph .n{font-family:var(--display);font-weight:700;font-size:14px;line-height:1.1;overflow-wrap:anywhere}
.wdc .ph .m{font-size:11px;color:var(--ink-soft);line-height:1.2}
.wdc .ph .m b{color:var(--ink)}
.wdc .ph .m .unk{color:var(--ink-mute);font-weight:400}
.wdc .ph a{font-family:var(--display);font-weight:700;font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:var(--warp);text-decoration:none}
.wdc .ph.locked .n{color:var(--ink-mute);text-decoration:line-through}
.wdc .cell{display:flex;flex-direction:column;align-items:center;justify-content:center;width:100%;min-height:54px;padding:6px 4px;border-radius:0;font-family:var(--display);font-weight:900;font-size:20px;line-height:1;color:var(--ink);position:relative}
.wdc .cell .oth{font-size:.6em;color:var(--ink-mute)}
.wdc .cell small{font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--ink-mute);margin-top:3px}
.wdc .cell.good{background:rgba(111,207,142,.26)}
@media (prefers-color-scheme:light){.wdc .cell.good{background:rgba(111,207,142,.16)}}
.wdc .cell.bad{background:rgba(240,138,106,.16)}
.wdc .cell.even{background:transparent}
.wdc .cell.best::after{content:"";position:absolute;inset:3px;border:2px solid var(--warp);border-radius:8px;pointer-events:none}
.wdc .cell.lock{background:var(--warp);color:#fff}
.wdc .cell.lock small,.wdc .cell.lock .oth{color:rgba(255,255,255,.8)}
.wdc .cell.dim{opacity:.28}
.wdc .cell .fx{position:absolute;top:4px;right:6px;font-family:var(--body);font-size:11px;font-weight:900;line-height:1;color:var(--ink);opacity:.8;pointer-events:none}
.wdc .cell .hx{position:absolute;top:4px;left:6px;font-family:var(--body);font-size:11px;font-weight:900;line-height:1;color:var(--ink);opacity:.8;pointer-events:none}
.wdc .cell.lock .fx,.wdc .cell.lock .hx{color:rgba(255,255,255,.8)}
/* detail line above the grid (t-740): the last tapped cell's forecast, faction matchup and history, since touch screens never
   show title text. Phones: it wraps, and once a cell is tapped it sticks to the top while the page scrolls the grid by. */
.wdc .pdetail{position:relative;z-index:4;min-width:0}
.wdc .pdetail.on{position:sticky;top:0;background:var(--ground);padding:4px 0}
.wdc .pdetail .legend{font-size:14px;color:var(--ink-mute)}
.wdc .pdl{display:block;width:100%;min-height:44px;text-align:left}
.wdc .pdl .in{display:flex;align-items:baseline;gap:10px;min-height:44px;padding:8px 12px;border:1px solid var(--warp);border-radius:10px;background:var(--deep);font-size:14px;line-height:1.35;color:var(--ink)}
.wdc .pdl .t{flex:1 1 auto;min-width:0;overflow-wrap:anywhere}
.wdc .pdl .more{display:none;flex:0 0 auto;font-family:var(--display);font-weight:700;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--warp)}
.wdc .dsheet{margin-top:6px;background:var(--deep);border:1px solid var(--warp);border-radius:10px;padding:10px 12px;font-size:14px;color:var(--ink);box-shadow:0 8px 24px rgba(0,0,0,.4)}
.wdc .dsheet .full{overflow-wrap:anywhere}
.wdc .dsheet .legend{margin-top:6px;font-size:13px}
.wdc .dsheet .x{margin-top:8px;min-width:44px;min-height:44px;padding:0 16px;border:1px solid var(--rule);border-radius:999px;font-family:var(--display);font-weight:700;font-size:14px}

/* score pad */
.wdc .pad{position:fixed;inset:0;background:var(--ground);z-index:50;display:flex;flex-direction:column;padding:calc(env(safe-area-inset-top,0px) + 12px) 16px calc(env(safe-area-inset-bottom,0px) + 16px);overflow:auto}
.wdc .pad .head{display:flex;align-items:center;justify-content:space-between;gap:12px;max-width:900px;margin:0 auto;width:100%}
.wdc .pad .head h2{font-size:clamp(20px,3vw,28px);font-weight:900;text-transform:uppercase}
.wdc .pad .head h2 span{color:var(--warp)}
.wdc .pad .head .x{min-width:44px;min-height:44px;border:1px solid var(--rule);border-radius:999px;font-family:var(--display);font-weight:700;font-size:14px;padding:0 16px}
.wdc .pad .match{max-width:900px;margin:8px auto 0;width:100%;display:grid;grid-template-columns:1fr auto 1fr;gap:12px;align-items:center;font-family:var(--display)}
.wdc .pad .match .n{font-size:22px;font-weight:700;line-height:1.1}
.wdc .pad .match .f{font-family:var(--body);font-size:14px;color:var(--ink-soft)}
.wdc .pad .match .vs{color:var(--ink-mute);font-weight:700}
.wdc .pad .match .r{text-align:right}
.wdc .pad .hint{max-width:900px;margin:14px auto 0;width:100%;color:var(--ink-soft);font-size:15px}
.wdc .keys{max-width:900px;margin:10px auto 0;width:100%;display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:8px}
.wdc .keys button{aspect-ratio:1.15;min-width:0;min-height:56px;border-radius:14px;background:var(--panel);border:1px solid var(--rule);font-family:var(--display);font-weight:900;font-size:clamp(22px,4.5vw,34px)}
.wdc .keys button.sel{background:var(--warp);border-color:var(--warp);color:#fff}
.wdc .keys button.fc{box-shadow:inset 0 0 0 2px var(--warp)}
.wdc .keys button:active{transform:scale(.96)}
.wdc .keys button:disabled{opacity:.5}
/* phones: seven 1.15-ratio keys at 56px tall need 531px, so below that the keys drop the ratio and stay 56px tall */
@media (max-width:560px){.wdc .keys{gap:6px}.wdc .keys button{aspect-ratio:auto;border-radius:12px}}
.wdc .pad .foot{max-width:900px;margin:14px auto 0;width:100%;display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between;color:var(--ink-soft);font-size:14px}
.wdc .pad .foot .clear{min-height:44px;padding:0 16px;border:1px solid var(--rule);border-radius:999px;font-family:var(--display);font-weight:700;font-size:14px;color:var(--bad)}

/* coach PIN entry (inside the pad, or a small sheet over the board) */
.wdc .pinbox{max-width:900px;width:100%;margin:12px auto 0;background:var(--deep);border:1px solid var(--warp);border-radius:12px;padding:12px 14px;display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px}
.wdc .pinbox p{flex:1 1 100%;font-size:14px;color:var(--ink-soft)}
.wdc .pinbox label{font-family:var(--display);font-weight:700;font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:var(--ink-mute)}
.wdc .pinbox input{min-height:44px;width:10em;padding:0 12px;border:1px solid var(--rule);border-radius:8px;background:var(--panel);color:var(--ink);font:inherit;font-size:18px}
.wdc .pinbox button{min-height:44px;padding:0 16px;border-radius:999px;font-family:var(--display);font-weight:700;font-size:14px}
.wdc .pinbox button[type="submit"]{background:var(--warp);color:#fff}
.wdc .pinbox button[type="button"]{border:1px solid var(--rule);color:var(--ink-soft)}
.wdc .pinsheet{position:fixed;left:0;right:0;bottom:0;z-index:55;padding:0 16px calc(env(safe-area-inset-bottom,0px) + 16px)}

/* forecast weights: a header button and an overlay sheet (like the PIN sheet), so the one-screen layout never moves */
.wdc .wbtn{min-height:44px;padding:0 16px;border:1px solid var(--rule);border-radius:999px;font-family:var(--display);font-weight:700;font-size:14px;color:var(--ink-soft)}
.wdc .wbtn[aria-expanded="true"]{border-color:var(--warp);color:var(--warp)}
.wdc .wsheet{position:fixed;inset:0;z-index:52;background:rgba(0,0,0,.5);display:flex;justify-content:center;align-items:flex-start;padding:calc(env(safe-area-inset-top,0px) + 56px) 16px 16px;overflow:auto}
.wdc .wpanel{width:100%;max-width:560px;background:var(--deep);border:1px solid var(--warp);border-radius:14px;padding:10px 14px 12px}
.wdc .whead{display:flex;align-items:center;justify-content:space-between;gap:12px}
.wdc .whead h2{font-size:20px;font-weight:900;text-transform:uppercase}
.wdc .whead h2 span{color:var(--warp)}
.wdc .whead .x{min-width:44px;min-height:44px;padding:0 16px;border:1px solid var(--rule);border-radius:999px;font-family:var(--display);font-weight:700;font-size:14px}
.wdc .wrows{list-style:none;margin:8px 0 0;padding:0}
.wdc .wrow{display:flex;align-items:center;gap:12px;padding:8px 0;border-top:1px solid var(--rule)}
.wdc .wtxt{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:2px}
.wdc .wl{font-family:var(--display);font-weight:700;font-size:16px;line-height:1.15}
.wdc .wd{font-size:13px;color:var(--ink-soft);line-height:1.25}
.wdc .wctl{flex:0 0 auto;display:flex;align-items:center;gap:6px}
.wdc .wctl button{min-width:44px;min-height:44px;border:1px solid var(--rule);border-radius:8px;font-family:var(--display);font-weight:700;font-size:20px;background:var(--panel-2)}
.wdc .wctl button:disabled{opacity:.35}
.wdc .wv{min-width:56px;text-align:center;font-family:var(--display);font-weight:900;font-size:20px}
.wdc .wfoot{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px 12px;border-top:1px solid var(--rule);padding-top:10px;font-size:13px;color:var(--ink-mute)}
.wdc .wfoot .wreset{min-height:44px;padding:0 16px;border:1px solid var(--rule);border-radius:999px;font-family:var(--display);font-weight:700;font-size:14px;color:var(--ink-soft)}
.wdc .wfoot .wreset:disabled{opacity:.4}

.wdc .toast{position:fixed;left:50%;bottom:calc(env(safe-area-inset-bottom,0px) + 18px);transform:translateX(-50%);background:var(--ink);color:var(--ground);padding:10px 16px;border-radius:999px;font-family:var(--display);font-weight:700;font-size:14px;z-index:60;opacity:0;transition:opacity .2s;pointer-events:none}
.wdc .toast.on{opacity:1}
.wdc .readonly{max-width:1180px;margin:10px auto 0;font-size:14px;color:var(--ink-mute)}
.wdc .empty{max-width:1180px;margin:24px auto;padding:24px;border:1px dashed var(--rule);border-radius:14px;color:var(--ink-soft)}

/* tablet: one screen, nothing scrolls (Fire HD 10 at 1280x800, iPad landscape at 1024x768) */
@media (min-width:900px) and (orientation:landscape){
  .wdc{position:fixed;inset:0;min-height:0;height:100%;overflow:hidden;display:flex;flex-direction:column;padding:8px 14px}
  .wdc .app{flex:1 1 auto;min-height:0;display:flex;flex-direction:column}
  .wdc .top{flex:0 0 auto;margin:0;width:100%;max-width:none;align-items:center}
  .wdc .top h1{font-size:clamp(18px,2.6vh,26px)}
  .wdc .rounds button{min-height:44px;min-width:44px;padding:0 10px;font-size:13px}
  .wdc .views{padding:2px;gap:2px}
  .wdc .views button{min-height:44px;padding:0 14px}
  .wdc .stale{flex:0 0 auto;margin:2px 0 0;width:100%;max-width:none;font-size:12px}
  .wdc .strip{flex:0 0 auto;margin:6px auto 0;width:100%;padding:8px 14px;gap:4px 18px;grid-template-columns:1.6fr 1fr 1fr 1fr 1fr;border-radius:10px}
  .wdc .strip .vs{grid-column:1;grid-row:1/3;flex-direction:column;align-items:flex-start;gap:2px}
  .wdc .strip .vs h2{font-size:clamp(16px,2.6vh,22px)}
  .wdc .strip .vs .oppelo{font-size:12px}
  .wdc .stat .lab{font-size:10px}
  .wdc .stat .val{font-size:clamp(20px,3.6vh,30px)}
  .wdc .stat .sub{font-size:11px;margin-top:1px}
  .wdc .need{grid-column:2/-1;grid-row:2;border-top:0;padding-top:0;font-size:13px;gap:4px 16px}
  .wdc .grid{flex:1 1 auto;min-height:0;margin:6px auto 0;width:100%;max-width:none;grid-template-columns:repeat(4,1fr);grid-template-rows:1fr 1fr;gap:8px}
  .wdc .card{min-height:0;overflow:hidden;padding:8px 10px 6px;gap:4px 8px;border-radius:10px;grid-template-rows:auto 1fr 1fr auto}
  /* a name is one line here (ellipsis, the full name in its title): a two-line name pushed the forecast
     row's 44px buttons past the card bottom at 1024x768 (Nicholas Fromme, Dustin Hammond, Justin Mooneyham) */
  .wdc .side .who{font-size:clamp(14px,2.2vh,18px);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;overflow-wrap:normal}
  .wdc .side .meta{font-size:clamp(10px,1.6vh,13px);margin-top:1px;gap:1px 6px}
  .wdc .score{min-width:78px;min-height:0;padding:6px 4px;border-radius:10px}
  .wdc .score .big{font-size:clamp(24px,5vh,38px)}
  .wdc .score .big small{font-size:clamp(12px,2vh,16px)}
  .wdc .score .lab{font-size:9px}
  .wdc .pred{padding-top:5px;font-size:11px;gap:6px}
  .wdc .pred .bar{height:5px;min-width:20px}
  .wdc .listlink{min-height:44px;padding:0 10px;font-size:10px}
  .wdc .nudge{gap:3px}
  .wdc .nudge button{min-width:44px;min-height:44px;font-size:15px}
  .wdc .readonly{flex:0 0 auto;margin:4px auto 0;font-size:11px;width:100%;max-width:none}
  .wdc .empty{margin:12px auto}
  .wdc .pair{flex:1 1 auto;margin-top:6px;gap:6px;width:100%;max-width:none}
  /* the pairing bar stays on one line so the 8x8 matrix keeps the height */
  .wdc .pair .bar{flex-wrap:nowrap;gap:8px 10px;padding:6px 12px}
  .wdc .pair .bar>*{flex:0 0 auto}
  .wdc .pair .bar label{font-size:11px;letter-spacing:.1em}
  /* three classes plus an element: outranks the .bar>* rule above so the select is the one that shrinks and truncates */
  .wdc .pair .bar select{flex:0 1 190px;min-width:80px;max-width:260px;min-height:44px;text-overflow:ellipsis}
  .wdc .pair .bar .sum{flex:1 0 auto;min-width:max-content;flex-wrap:nowrap;gap:0 10px;white-space:nowrap;font-size:12px;justify-content:flex-end}
  .wdc .pair .bar .sum b{font-size:16px}
  .wdc .pair .bar .go{padding:0 14px;font-size:13px;white-space:nowrap}
  .wdc .pair .bar .reset,.wdc .pair .bar .showall{padding:0 12px;font-size:12px;white-space:nowrap}
  .wdc .mwrap{flex:1 1 auto}
  /* detail line: one 19px line where the footnote used to sit (6px gap + 19px = the old 6 + 4 + 14.85), so the grid keeps its
     height; the button's 44px tap target is padding offset by negative margin, reaching only the gap above and the header top */
  .wdc .pdetail{flex:0 0 auto}
  .wdc .pdetail.on{position:relative;padding:0;background:none}
  .wdc .pdetail .legend{font-size:12px;line-height:19px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .wdc .pdl{min-height:0;height:44px;padding:12.5px 0;margin:-12.5px 0}
  .wdc .pdl .in{align-items:center;min-height:0;height:19px;padding:0 10px;border:0;border-radius:6px;font-size:13px;line-height:19px;white-space:nowrap}
  .wdc .pdl .t{overflow:hidden;text-overflow:ellipsis;overflow-wrap:normal}
  .wdc .pdl .more{display:inline}
  .wdc .dsheet{position:absolute;left:0;right:0;top:calc(100% + 6px);margin:0;max-height:60vh;overflow:auto}
  /* cells fill the row the player headers set (a 1px cell height lets the button take 100%) */
  .wdc .matrix td{height:1px}
  .wdc .cell{min-height:0;height:100%;padding:4px 2px;font-size:clamp(14px,2.6vh,20px)}
  .wdc .cell small{font-size:9px;margin-top:1px}
  .wdc .ph{padding:4px 6px;gap:1px}
  .wdc .ph .n{font-size:clamp(11px,1.8vh,14px)}
  .wdc .ph .m{font-size:10px}
  /* matrix header LIST link: a 24px tap target that adds no layout height (padding offset by negative margin) */
  .wdc .ph a{display:inline-block;align-self:flex-start;line-height:14px;padding:5px 8px;margin:-5px -8px}
}
@media (prefers-reduced-motion:reduce){.wdc .card,.wdc .keys button,.wdc .toast{transition:none}}
`;
