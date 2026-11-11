/**
 * ui/flowCss.ts — one stylesheet for every screen of the flow (ui/flow.ts).
 * Broadcast furniture over the live 3D scene: dark glass panels, heavy italic
 * caps for names, gold for the house, `--c` (the fighter's trunks colour) as
 * the accent on anything that belongs to a fighter. Nothing is a full black
 * screen: the ring is always behind it.
 *
 * One rule runs through the layouts: a panel never covers the men it is
 * about. Sheets about a fighter or a fight sit on the right (a bottom sheet
 * on a phone held upright) and the director puts the figures on the left.
 */
export const FLOW_CSS = `
#flow { position: fixed; inset: 0; z-index: 20; pointer-events: none; font-family: "Helvetica Neue", Arial, system-ui, sans-serif; color: #f4f1e8; --gold: #d8b45a; --c: #d8b45a; -webkit-user-select: none; user-select: none; }
#flow * { box-sizing: border-box; }
body.flow-menu #touch-ui { display: none; }
#flow .screen { position: absolute; inset: 0; display: none; }
#flow .screen.on { display: block; }
#flow .screen.title { background: linear-gradient(90deg, #000c 0%, #0007 34%, #0000 62%); }
#flow .screen.select, #flow .screen.opponent, #flow .screen.ladder, #flow .screen.champion { background: linear-gradient(#0008, #0000 22%, #0000 70%, #000a); }
#flow .screen.gym, #flow .screen.controls { background: #0007; }

#flow .panel { pointer-events: auto; background: linear-gradient(#0c0c10e8, #060608f2); border-top: 2px solid var(--c); box-shadow: 0 0 0 1px #fff1, 0 12px 34px #000b; }
#flow .head { position: absolute; left: 0; right: 0; text-align: center; top: 20px; font-size: 12px; font-weight: 700; letter-spacing: 0.4em; text-transform: uppercase; color: var(--gold); text-shadow: 0 1px 2px #000; }
#flow .hint { position: absolute; left: 0; right: 0; bottom: 12px; text-align: center; font-size: 10px; letter-spacing: 0.26em; text-transform: uppercase; color: #fffb; text-shadow: 0 1px 2px #000, 0 0 8px #000; }
#flow .hint.top { bottom: auto; top: 16px; }
#flow .btns { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
#flow .btn { pointer-events: auto; cursor: pointer; padding: 10px 18px; text-align: center; font-size: 12px; font-weight: 800; letter-spacing: 0.2em; text-transform: uppercase; white-space: nowrap;
  background: linear-gradient(#3a2d0c, #15100a 70%, #0a0806); border: 1px solid var(--gold); color: #f3dc8f; box-shadow: 0 0 0 1px #000c, 0 4px 14px #000a; }
#flow .btn.sel, #flow .btn:hover { background: linear-gradient(#e9cf7a, #c9a24a 60%, #a8842f); color: #1a1206; border-color: #fff2c0; }
#flow .btn.quiet { background: #0008; border-color: #fff4; color: #fffc; }
#flow .btn.quiet.sel, #flow .btn.quiet:hover { background: #fff; color: #111; border-color: #fff; }
#flow .lhead { font-size: 8.5px; font-weight: 700; letter-spacing: 0.3em; text-transform: uppercase; color: var(--gold); margin-top: 10px; }

/* title */
#flow .titlebox { position: absolute; left: clamp(20px, 6vw, 96px); top: 50%; transform: translateY(-50%); }
#flow .wordmark { width: clamp(230px, 34vw, 430px); filter: drop-shadow(0 0 26px #d8b45a33); }
#flow .wordmark svg { display: block; width: 100%; height: auto; }
#flow .menu { display: flex; flex-direction: column; gap: 8px; margin-top: 26px; width: 230px; }
#flow .menu .btn { text-align: left; font-size: 14px; padding: 12px 20px; }
#flow .titlebox .foot { margin-top: 18px; font-size: 10px; letter-spacing: 0.26em; text-transform: uppercase; color: #fff9; }

/* fighter sheet (select, opponent, ladder), and the results and corner sheets that share its place */
#flow .info, #flow .corner { position: absolute; right: 24px; top: 46px; bottom: 96px; width: min(388px, 41vw); overflow: hidden; display: flex; flex-direction: column; }
#flow .info .scroll, #flow .corner .scroll { flex: 1; min-height: 0; overflow-y: auto; padding: 14px 20px 10px; }
#flow .info .foot { padding: 0 20px 14px; }
#flow .info .foot .btns { margin-top: 10px; }
#flow .fname { font-size: clamp(22px, 2.8vw, 31px); font-weight: 900; font-style: italic; text-transform: uppercase; letter-spacing: 0.02em; line-height: 0.98; overflow-wrap: anywhere; }
#flow .fnick { font-size: 11px; font-weight: 700; letter-spacing: 0.24em; text-transform: uppercase; color: color-mix(in srgb, var(--c) 60%, #fff); margin-top: 5px; }
#flow .fmeta { font-size: 12px; color: #fffc; margin-top: 6px; line-height: 1.4; }
#flow .sizes, #flow .ratings { display: grid; gap: 4px 8px; font-size: 9px; letter-spacing: 0.18em; text-transform: uppercase; color: #fffb; align-items: center; }
#flow .sizes { margin-top: 10px; grid-template-columns: 66px 1fr 58px; }
#flow .ratings { margin-top: 9px; padding-top: 9px; border-top: 1px solid #fff2; grid-template-columns: 66px 1fr 58px; }
#flow .sizes .bar, #flow .ratings .bar, #flow .cond .bar { height: 7px; background: #0009; border: 1px solid #fff3; }
#flow .sizes .bar { height: 5px; }
#flow .sizes .fill { height: 100%; background: #f4f1e8; }
#flow .ratings .fill, #flow .cond .fill { height: 100%; background: var(--c); }
#flow .sizes i, #flow .ratings i { font-style: normal; text-align: right; font-size: 11.5px; font-weight: 700; letter-spacing: 0; text-transform: none; font-variant-numeric: tabular-nums; color: #fff; white-space: nowrap; }
#flow .matchup { margin-top: 10px; padding: 6px 10px 7px; background: #fff1; border-left: 3px solid var(--gold); font-size: 12px; line-height: 1.4; }
#flow .matchup .lhead { display: block; margin: 0 0 2px; }
#flow .style { margin-top: 10px; padding-top: 9px; border-top: 1px solid #fff2; }
#flow .style .sname { font-size: 13px; font-weight: 800; letter-spacing: 0.16em; text-transform: uppercase; color: color-mix(in srgb, var(--c) 60%, #fff); }
#flow .style .sfacts { font-size: 12px; font-weight: 700; margin-top: 4px; }
#flow .style .sfacts span { font-size: 8.5px; font-weight: 700; letter-spacing: 0.24em; text-transform: uppercase; color: #fff9; margin: 0 6px 0 0; }
#flow .style .sfacts span + span, #flow .style .sfacts span:nth-of-type(2) { margin-left: 14px; }
#flow .style .blurb { font-size: 12px; line-height: 1.4; margin-top: 5px; color: #fff; }
#flow .style ul { margin: 4px 0 0; padding: 0; list-style: none; }
#flow .style li { font-size: 11.5px; line-height: 1.38; color: #fffd; padding-left: 12px; position: relative; margin-top: 3px; }
#flow .style li::before { content: ""; position: absolute; left: 0; top: 0.55em; width: 5px; height: 2px; background: var(--c); }
#flow .opts { padding-top: 6px; border-top: 1px solid #fff2; }
#flow .opt { display: grid; grid-template-columns: 78px 1fr; align-items: center; gap: 8px; margin-top: 5px; font-size: 9px; letter-spacing: 0.2em; text-transform: uppercase; color: #fff9; padding: 2px 4px; border-left: 2px solid #0000; }
#flow .opt.row { border-left-color: var(--gold); color: #fff; }
#flow .opt .choices { display: flex; gap: 4px; }
#flow .opt .ch { pointer-events: auto; cursor: pointer; flex: 1; padding: 6px 2px; text-align: center; font-size: 10px; font-weight: 700; letter-spacing: 0.08em; background: #fff1; border: 1px solid #fff2; color: #fffc; white-space: nowrap; }
#flow .opt .ch.sel { background: var(--gold); border-color: #fff2c0; color: #1a1206; }

/* the strip of name plates */
#flow .strip { position: absolute; left: 24px; right: 24px; bottom: 34px; display: flex; gap: 5px; }
#flow .strip.row .plate.sel { box-shadow: 0 0 0 1px var(--c), 0 6px 18px #000a; }
#flow .plate { pointer-events: auto; cursor: pointer; flex: 1 1 0; min-width: 0; padding: 0 6px 6px; background: #0a0a0ed9; border: 1px solid #fff2; transition: transform .1s; }
#flow .plate .sw { height: 4px; margin: 0 -6px 6px; background: linear-gradient(90deg, var(--c) 70%, var(--c2) 70%); }
#flow .plate .pn { font-size: clamp(10px, 1.15vw, 13px); font-weight: 900; font-style: italic; text-transform: uppercase; letter-spacing: 0.02em; line-height: 1.05; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#flow .plate .ps { font-size: 8px; letter-spacing: 0.16em; text-transform: uppercase; color: #fff8; margin-top: 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#flow .plate.sel { transform: translateY(-5px); border-color: var(--c); background: #16161cf2; }
#flow .plate.off { opacity: 0.32; cursor: default; }
#flow .plate.rung { cursor: default; }
#flow .plate.won { background: #0a0a0e99; border-color: #fff1; } #flow .plate.won .pn { text-decoration: line-through; color: #fff7; } #flow .plate.won .sw { opacity: 0.35; } #flow .plate.won .ps { color: var(--gold); }
#flow .plate i { font-style: normal; color: var(--gold); margin-right: 6px; }

/* ladder */
#flow .ladhead { position: absolute; left: 24px; top: 18px; padding-left: 12px; border-left: 5px solid var(--c); text-shadow: 0 2px 3px #000c; }
#flow .ladhead small { display: block; font-size: 10px; font-weight: 700; letter-spacing: 0.4em; text-transform: uppercase; color: var(--gold); }
#flow .ladhead b { display: block; font-size: clamp(20px, 2.6vw, 30px); font-weight: 900; font-style: italic; text-transform: uppercase; line-height: 1.05; }
#flow .ladhead .rec { display: block; font-size: 13px; font-weight: 800; letter-spacing: 0.18em; text-transform: uppercase; color: #f3dc8f; margin-top: 2px; }
#flow .tag { display: inline-block; font-size: 9px; font-weight: 800; letter-spacing: 0.2em; text-transform: uppercase; padding: 3px 7px; background: var(--gold); color: #1a1206; margin-bottom: 8px; }

/* gym, controls: a sheet */
#flow .sheet { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); width: min(880px, 94vw); max-height: 94vh; padding: 18px 22px; overflow-y: auto; }
#flow .sheet.wide { width: min(1120px, 96vw); }
#flow .sheet h2 { margin: 0 0 4px; font-size: 22px; font-weight: 900; font-style: italic; text-transform: uppercase; letter-spacing: 0.03em; }
#flow .sheet .sub { font-size: 11px; color: #fffa; margin: 2px 0 10px; line-height: 1.4; }
#flow .shead { position: sticky; top: -18px; z-index: 1; display: flex; align-items: center; justify-content: space-between; margin: -18px -22px 0; padding: 12px 22px 6px; background: #0a0a0e; }
#flow .shead h2 { margin: 0; } #flow .shead .btns { margin: 0; } #flow .shead .btn { padding: 7px 16px; }
#flow .drills { display: flex; flex-direction: column; gap: 4px; }
#flow .ditem { pointer-events: auto; cursor: pointer; display: grid; grid-template-columns: 24px 1fr; gap: 1px 10px; padding: 6px 12px; background: #fff1; border-left: 3px solid #0000; }
#flow .ditem.sel, #flow .ditem:hover { background: #fff2; border-left-color: var(--gold); }
#flow .ditem .n { grid-row: 1 / 4; font-size: 19px; font-weight: 900; font-style: italic; color: var(--gold); line-height: 1.1; }
#flow .ditem .t { font-size: 13px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.06em; }
#flow .ditem .t small { font-size: 9px; font-weight: 700; letter-spacing: 0.16em; color: #fff8; margin-left: 10px; }
#flow .ditem .g { font-size: 11.5px; color: #fffd; line-height: 1.3; }
#flow .ditem .c { font-size: 10px; color: var(--gold); line-height: 1.3; }
#flow .ctl { display: grid; grid-template-columns: 1fr 1fr; gap: 0 26px; }
#flow .ctl h3 { margin: 10px 0 4px; font-size: 10px; letter-spacing: 0.3em; text-transform: uppercase; color: var(--gold); font-weight: 700; }
#flow .ctl table { width: 100%; border-collapse: collapse; font-size: 11.5px; }
#flow .ctl th { font-size: 8.5px; letter-spacing: 0.22em; text-transform: uppercase; color: #fff8; font-weight: 700; text-align: left; padding: 2px 6px; }
#flow .ctl td { padding: 3px 6px; border-top: 1px solid #fff1; vertical-align: top; line-height: 1.32; color: #fffd; }
#flow .ctl td.k { font-weight: 800; white-space: nowrap; color: #fff; }
#flow .ctl .ctl-moves td:nth-child(2) { color: #f3dc8f; width: 34%; }
#flow .ctl .note { font-size: 11px; line-height: 1.4; color: #fffb; margin: 7px 0 0; }
#flow .ctl .note b { color: #fff; }

/* ring walk */
#flow .screen.walk { pointer-events: auto; }
#flow .namecard { position: absolute; left: clamp(14px, 5vw, 70px); bottom: 13%; min-width: 300px; max-width: 88vw; background: linear-gradient(90deg, #08080cf2 70%, #08080c99); border-left: 8px solid var(--c); box-shadow: 0 10px 30px #000a; padding: 12px 26px 12px 18px; }
#flow .namecard::after { content: ""; position: absolute; left: 0; right: 0; bottom: -4px; height: 4px; background: linear-gradient(90deg, var(--c2) 55%, #0000); }
#flow .namecard .fname { font-size: clamp(26px, 4.4vw, 46px); }
#flow .namecard .line { font-size: 12px; letter-spacing: 0.12em; text-transform: uppercase; color: #fffd; margin-top: 8px; }
/* the stare-down: a strip along the bottom edge, so both men stand clear above it */
#flow .tapecard { position: absolute; left: 0; right: 0; bottom: 0; display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; gap: 0 22px; padding: 9px 26px 11px; background: linear-gradient(#08080cd9, #050507f5); border-top: 2px solid var(--gold); }
#flow .tapecard .l { text-align: right; border-right: 6px solid var(--ca); padding-right: 12px; } #flow .tapecard .r { text-align: left; border-left: 6px solid var(--cb); padding-left: 12px; }
#flow .tapecard .fname { font-size: clamp(16px, 2.5vw, 28px); }
#flow .tapecard .tl { font-size: clamp(9px, 1vw, 11.5px); letter-spacing: 0.1em; text-transform: uppercase; color: #fffc; margin-top: 4px; }
#flow .tapecard .vs { text-align: center; font-size: 22px; font-weight: 900; font-style: italic; color: var(--gold); line-height: 1; }
#flow .tapecard .vs small { display: block; font-size: 9px; font-style: normal; font-weight: 700; letter-spacing: 0.22em; color: #fffc; margin-top: 5px; white-space: nowrap; text-transform: uppercase; }

/* in the fight */
#flow .third { position: absolute; left: 50%; top: 16%; transform: translateX(-50%); padding: 8px 30px; background: linear-gradient(#000c, #000e); border-top: 1px solid var(--gold); border-bottom: 1px solid var(--gold);
  font-size: 16px; font-weight: 900; font-style: italic; letter-spacing: 0.2em; text-transform: uppercase; opacity: 0; transition: opacity .35s; white-space: nowrap; }
#flow .third.on { opacity: 1; }
#flow .bug { position: absolute; left: 22px; top: 20px; padding: 5px 12px 4px; font-size: 11px; font-weight: 800; letter-spacing: 0.34em; background: #000b; border-left: 3px solid var(--gold); color: #f3dc8f; display: none; }
#flow .bug.on { display: block; }
#flow .skipzone { position: absolute; inset: 0; pointer-events: auto; display: none; }
#flow .skipzone.on { display: block; }
#flow .pausebtn { position: absolute; right: 12px; top: 12px; width: 32px; height: 32px; pointer-events: auto; cursor: pointer; display: none; align-items: center; justify-content: center; font-size: 11px; font-weight: 900; letter-spacing: 2px; padding-left: 2px; color: #fffa; background: #0007; border: 1px solid #fff3; border-radius: 50%; z-index: 2; }
#flow .pausebtn.on { display: flex; }
#flow .pausebtn:hover { color: #fff; border-color: #fff; }
#flow.touch .pausebtn { right: auto; left: 50%; top: 76px; transform: translateX(-50%); width: 40px; height: 40px; }
/* the corner card: the fighter sheet's place, so the ring and both corners stay in view on the left */
#flow .corner { display: none; border-top-color: var(--gold); bottom: 24px; }
#flow .corner.on { display: flex; }
#flow .corner .big { font-size: clamp(22px, 2.8vw, 30px); font-weight: 900; font-style: italic; text-transform: uppercase; line-height: 1; }
#flow .corner .nextup { font-size: 10px; letter-spacing: 0.3em; text-transform: uppercase; color: var(--gold); margin-top: 5px; }
#flow .cgrid { display: grid; grid-template-columns: 1fr auto 1fr; gap: 3px 12px; margin-top: 12px; align-items: center; }
#flow .cgrid .nm { font-size: 13px; font-weight: 900; font-style: italic; text-transform: uppercase; line-height: 1; padding-bottom: 5px; border-bottom: 3px solid var(--c); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#flow .cgrid .l { text-align: right; } #flow .cgrid .r { text-align: left; }
#flow .cgrid .v { font-size: 14px; font-weight: 800; font-variant-numeric: tabular-nums; }
#flow .cgrid .lbl { text-align: center; font-size: 9px; letter-spacing: 0.2em; text-transform: uppercase; color: #fffb; white-space: nowrap; }
#flow .cgrid .gap { grid-column: 1 / -1; height: 8px; }
#flow .cond .bar { position: relative; }
#flow .cond.l .fill { margin-left: auto; }
#flow .cond.bad .fill { background: #c8402c; }
#flow .advice { margin-top: 12px; padding: 9px 12px; background: #fff1; border-left: 3px solid var(--gold); font-size: 13px; line-height: 1.4; }
#flow .advice span { display: block; font-size: 8px; letter-spacing: 0.3em; text-transform: uppercase; color: var(--gold); margin-bottom: 3px; }
#flow .corner .foot { display: flex; align-items: center; justify-content: space-between; padding: 6px 20px 10px; border-top: 1px solid #fff2; font-size: 10px; letter-spacing: 0.24em; text-transform: uppercase; color: #fff9; }
#flow .corner .count { font-size: 22px; font-weight: 800; color: #f3dc8f; font-variant-numeric: tabular-nums; letter-spacing: 0; }
#flow .pause { position: absolute; inset: 0; background: #000a; pointer-events: auto; display: none; }
#flow .pause.on { display: block; }
#flow .pause .box { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); width: 280px; padding: 18px 22px 20px; border-top-color: var(--gold); }
#flow .pause .box h2 { margin: 0 0 4px; font-size: 24px; font-weight: 900; font-style: italic; text-transform: uppercase; }
#flow .pause .menu { width: auto; margin-top: 14px; }
/* the drill panel: a training screen, so it may say things */
/* a strip along the top, above the fighters' heads: what to do on the left, the controls on the right */
#flow .drill { position: absolute; left: 12px; right: 56px; top: 10px; max-width: 1040px; padding: 8px 12px 8px; display: none; grid-template-columns: minmax(0, 1fr) minmax(0, 1.15fr); gap: 0 18px; align-items: start; border-top-color: var(--gold); pointer-events: none; }
#flow .drill.on { display: grid; }
#flow .drill .t { font-size: 13px; font-weight: 800; letter-spacing: 0.1em; text-transform: uppercase; display: flex; align-items: baseline; gap: 8px; }
#flow .drill .t i { font-style: normal; font-size: 10px; letter-spacing: 0.12em; color: var(--gold); white-space: nowrap; }
#flow .drill .clk { margin-left: auto; font-size: 12px; letter-spacing: 0.04em; color: #f3dc8f; font-variant-numeric: tabular-nums; white-space: nowrap; }
#flow .drill .g { font-size: 11.5px; line-height: 1.35; color: #fffd; margin-top: 3px; }
#flow .drill table.dc { width: 100%; border-collapse: collapse; font-size: 10.5px; }
#flow .drill .dc th { font-size: 7.5px; letter-spacing: 0.22em; text-transform: uppercase; color: #fff8; font-weight: 700; text-align: left; padding: 1px 5px; }
#flow .drill .dc td { padding: 2px 5px; border-top: 1px solid #fff1; color: #fffd; vertical-align: top; line-height: 1.25; }
#flow .drill .dc td:first-child { font-weight: 800; color: #fff; }
#flow .drill .dc td.kb { color: #f3dc8f; }
#flow.touch .drill .kb { display: none; }
#flow .drill .prog { height: 5px; background: #0009; border: 1px solid #fff3; margin-top: 8px; }
#flow .drill .prog div { height: 100%; background: var(--gold); width: 0; }
#flow .drill .s { font-size: 12.5px; font-weight: 700; margin-top: 5px; font-variant-numeric: tabular-nums; color: #f3dc8f; min-height: 1.2em; }
#flow .drill.done .s { color: #fff; } #flow .drill.done .prog div { background: #fff; }
#flow .drill .k { font-size: 8.5px; letter-spacing: 0.2em; text-transform: uppercase; color: #fff8; margin-top: 5px; }
#flow.touch .drill .k { display: none; }
#flow .drill .dbtns { display: flex; gap: 5px; margin-top: 6px; }
#flow .drill .dbtn { pointer-events: auto; cursor: pointer; flex: 1; padding: 5px 2px; text-align: center; font-size: 9px; font-weight: 800; letter-spacing: 0.14em; text-transform: uppercase; background: #fff1; border: 1px solid #fff3; color: #fffc; white-space: nowrap; }
#flow .drill .dbtn:hover { background: #fff; color: #111; }
#flow.touch .drill { top: 84px; right: 12px; }

/* results: the fighter sheet's place; the pair stands to the left of it */
#flow .resultp { bottom: 24px; width: min(430px, 44vw); }
#flow .winner { font-size: clamp(24px, 3.2vw, 36px); font-weight: 900; font-style: italic; text-transform: uppercase; letter-spacing: 0.01em; line-height: 0.98; overflow-wrap: anywhere; }
#flow .method { margin-top: 6px; font-size: 11px; letter-spacing: 0.28em; text-transform: uppercase; color: var(--gold); }
#flow table.cards, #flow table.rounds { margin-top: 4px; border-collapse: collapse; font-size: 12.5px; font-variant-numeric: tabular-nums; width: 100%; }
#flow table.cards th, #flow table.cards td, #flow table.rounds th, #flow table.rounds td { padding: 3px 6px; text-align: center; border-bottom: 1px solid #fff2; }
#flow table.cards th, #flow table.rounds th { font-size: 8px; letter-spacing: 0.2em; text-transform: uppercase; color: #fff8; font-weight: 700; }
#flow table.cards td.n, #flow table.rounds td.n { text-align: left; font-weight: 800; font-style: italic; text-transform: uppercase; font-size: 11px; max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#flow table.cards td.t { font-weight: 800; color: var(--gold); }
#flow table.rounds td.rn { font-weight: 800; color: var(--gold); font-size: 11px; border-bottom-color: #fff4; }
#flow table.rounds tr.b td { border-bottom-color: #fff4; }
#flow .cardnote { font-size: 10px; color: #fff9; margin-top: 6px; line-height: 1.4; }
#flow .sgrid { display: grid; grid-template-columns: 1fr auto 1fr; gap: 1px 14px; align-items: center; align-content: start; margin-top: 4px; }
#flow .sgrid .nm { font-size: 11px; font-weight: 900; font-style: italic; text-transform: uppercase; padding-bottom: 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#flow .sgrid .l { text-align: right; } #flow .sgrid .r { text-align: left; }
#flow .sgrid .v { font-size: 12.5px; font-weight: 700; font-variant-numeric: tabular-nums; }
#flow .sgrid .lbl { text-align: center; font-size: 8px; letter-spacing: 0.24em; text-transform: uppercase; color: #fff9; white-space: nowrap; }
#flow .sgrid .rule { grid-column: 1 / -1; height: 1px; background: #fff2; margin: 3px 0; }

/* champion */
#flow .champ { position: absolute; right: clamp(16px, 4vw, 60px); top: 50%; transform: translateY(-50%); max-width: min(520px, 90vw); padding: 20px 26px; }
#flow .champ .big { font-size: clamp(40px, 7vw, 84px); font-weight: 900; font-style: italic; text-transform: uppercase; line-height: 0.9; color: #f3dc8f; text-shadow: 0 3px 0 #000; }

/* a short desktop window */
@media (max-height: 660px) and (min-width: 641px) {
  #flow .info .scroll, #flow .corner .scroll { padding: 10px 16px 8px; } #flow .info .foot { padding: 0 16px 10px; }
  /* sizes and ratings side by side, so the style lines stay above the fold */
  #flow .sr { display: grid; grid-template-columns: 1fr 1fr; gap: 0 14px; margin-top: 7px; align-items: start; }
  #flow .sizes, #flow .ratings { margin-top: 0; padding-top: 0; border-top: 0; gap: 2px 6px; grid-template-columns: 48px 1fr 46px; letter-spacing: 0.1em; font-size: 8.5px; }
  #flow .sizes i, #flow .ratings i { font-size: 10.5px; }
  #flow .fnick { display: inline; margin-right: 8px; } #flow .fmeta { display: inline; font-size: 11px; }
  #flow .info { bottom: 84px; }
  #flow .fmeta { margin-top: 4px; } #flow .matchup { margin-top: 7px; padding: 5px 9px 6px; font-size: 11.5px; }
  #flow .style { margin-top: 7px; padding-top: 7px; } #flow .style li { margin-top: 1px; font-size: 11px; } #flow .style .blurb { font-size: 11.5px; }
  #flow .opt { margin-top: 3px; } #flow .opt .ch { padding: 4px 2px; }
  #flow .info .foot .btns { margin-top: 7px; } #flow .info .btn { padding: 8px 16px; }
  #flow .fname { font-size: clamp(20px, 2.5vw, 27px); }
  #flow .ctl table { font-size: 11px; } #flow .ctl td { padding: 2px 6px; }
}
/* a phone held upright */
@media (max-width: 640px) {
  #flow .head { top: 10px; font-size: 10px; letter-spacing: 0.3em; }
  #flow .info, #flow .corner { left: 8px; right: 8px; top: auto; bottom: 8px; width: auto; max-height: 42vh; }
  #flow .corner, #flow .resultp { max-height: 56vh; }
  #flow .info .scroll, #flow .corner .scroll { padding: 10px 14px 8px; } #flow .info .foot { padding: 0 14px 10px; }
  #flow .screen.title { background: linear-gradient(#000b, #0005 45%, #0003 70%, #000a); }
  #flow .champ { left: 8px; right: 8px; top: auto; bottom: 8px; transform: none; max-width: none; }
  #flow .strip { left: 8px; right: 8px; top: 34px; bottom: auto; overflow-x: auto; }
  #flow .plate { flex: 0 0 92px; } #flow .plate.sel { transform: none; }
  #flow .ladhead { display: none; }
  #flow .hint { display: none; }
  #flow .menu { width: 210px; }
  #flow .namecard { min-width: 0; bottom: 22%; }
  #flow .tapecard { grid-template-columns: 1fr; gap: 6px; padding: 8px 12px; } #flow .tapecard .l, #flow .tapecard .r { text-align: left; border: 0; border-left: 6px solid var(--ca); padding: 0 0 0 10px; } #flow .tapecard .r { border-left-color: var(--cb); }
  #flow .ctl { grid-template-columns: 1fr; } #flow .ctl table { font-size: 11px; } #flow .ctl td { padding: 4px 4px; }
  #flow .sheet { padding: 14px 12px; }
  #flow .drill { grid-template-columns: 1fr; right: 12px; } #flow .drill .pd { display: none; } #flow .drill table.dc { margin-top: 6px; }
}
/* a phone on its side: short. The plates lose their second line; the sheet takes more width and its text is smaller. */
@media (max-height: 460px) and (min-width: 641px) {
  #flow .head { top: 8px; }
  #flow .info, #flow .corner { top: 28px; bottom: 44px; width: 46vw; right: 10px; }
  #flow .corner, #flow .resultp { bottom: 8px; }
  #flow .strip { bottom: 6px; left: 10px; right: 10px; }
  #flow .plate { padding: 0 5px 4px; } #flow .plate .ps { display: none; } #flow .plate .pn { font-size: 10px; } #flow .plate .sw { margin-bottom: 4px; }
  #flow .hint { display: none; }
  #flow .fname { font-size: 19px; } #flow .fnick { font-size: 9px; margin-top: 3px; } #flow .fmeta { font-size: 11px; margin-top: 3px; }
  #flow .sizes, #flow .ratings { gap: 1px 8px; grid-template-columns: 58px 1fr 52px; } #flow .sizes i, #flow .ratings i { font-size: 10.5px; }
  #flow .info .btn { padding: 6px 12px; font-size: 11px; }
  #flow .wordmark { width: 200px; } #flow .menu { margin-top: 12px; gap: 5px; } #flow .menu .btn { padding: 7px 16px; font-size: 12px; } #flow .titlebox .foot { display: none; }
  #flow .ladhead b { font-size: 16px; } #flow .ladhead .rec { font-size: 10px; }
  #flow .drill .g { display: none; } #flow .drill .dc td { padding: 1px 5px; }
  #flow .ctl table { font-size: 10px; } #flow .ctl td { padding: 1px 5px; }
}
`;
