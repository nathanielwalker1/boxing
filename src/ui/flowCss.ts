/**
 * ui/flowCss.ts — one stylesheet for every screen of the flow (ui/flow.ts).
 * Broadcast furniture over the live 3D scene: dark glass panels, heavy italic
 * caps for names, gold for the house, `--c` (the fighter's trunks colour) as
 * the accent on anything that belongs to a fighter. Nothing is a full black
 * screen: the ring is always behind it.
 */
export const FLOW_CSS = `
#flow { position: fixed; inset: 0; z-index: 20; pointer-events: none; font-family: "Helvetica Neue", Arial, system-ui, sans-serif; color: #f4f1e8; --gold: #d8b45a; --c: #d8b45a; -webkit-user-select: none; user-select: none; }
#flow * { box-sizing: border-box; }
body.flow-menu #touch-ui { display: none; }
#flow .screen { position: absolute; inset: 0; display: none; }
#flow .screen.on { display: block; }
#flow .screen.title { background: linear-gradient(90deg, #000d 0%, #0009 38%, #0000 72%); }
#flow .screen.select, #flow .screen.opponent, #flow .screen.ladder, #flow .screen.champion { background: linear-gradient(#0008, #0000 22%, #0000 70%, #000a); }
#flow .screen.gym, #flow .screen.controls { background: #0007; }
#flow .screen.results { background: linear-gradient(#0000 30%, #000b); }

#flow .panel { pointer-events: auto; background: linear-gradient(#0c0c10e8, #060608f2); border-top: 2px solid var(--c); box-shadow: 0 0 0 1px #fff1, 0 12px 34px #000b; }
#flow .head { position: absolute; left: 0; right: 0; text-align: center; top: 22px; font-size: 12px; font-weight: 700; letter-spacing: 0.4em; text-transform: uppercase; color: var(--gold); text-shadow: 0 1px 2px #000; }
#flow .hint { position: absolute; left: 0; right: 0; bottom: 14px; text-align: center; font-size: 10px; letter-spacing: 0.26em; text-transform: uppercase; color: #fff9; text-shadow: 0 1px 2px #000; }
#flow .btns { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
#flow .btn { pointer-events: auto; cursor: pointer; padding: 10px 18px; text-align: center; font-size: 12px; font-weight: 800; letter-spacing: 0.2em; text-transform: uppercase; white-space: nowrap;
  background: linear-gradient(#3a2d0c, #15100a 70%, #0a0806); border: 1px solid var(--gold); color: #f3dc8f; box-shadow: 0 0 0 1px #000c, 0 4px 14px #000a; }
#flow .btn.sel, #flow .btn:hover { background: linear-gradient(#e9cf7a, #c9a24a 60%, #a8842f); color: #1a1206; border-color: #fff2c0; }
#flow .btn.quiet { background: #0008; border-color: #fff4; color: #fffc; }
#flow .btn.quiet.sel, #flow .btn.quiet:hover { background: #fff; color: #111; border-color: #fff; }

/* title */
#flow .titlebox { position: absolute; left: clamp(20px, 7vw, 110px); top: 50%; transform: translateY(-50%); }
#flow .wordmark { font-size: clamp(50px, 10vw, 116px); font-weight: 900; font-style: italic; letter-spacing: 0.01em; line-height: 0.86; text-shadow: 0 4px 0 #000, 0 0 40px #d8b45a44; }
#flow .wordmark small { display: block; font-size: 12px; font-style: normal; font-weight: 700; letter-spacing: 0.5em; color: var(--gold); margin-top: 16px; text-shadow: 0 1px 2px #000; }
#flow .menu { display: flex; flex-direction: column; gap: 8px; margin-top: 30px; width: 230px; }
#flow .menu .btn { text-align: left; font-size: 14px; padding: 12px 20px; }
#flow .titlebox .foot { margin-top: 20px; font-size: 10px; letter-spacing: 0.26em; text-transform: uppercase; color: #fff9; }

/* fighter info (select, opponent, ladder, champion) */
#flow .info { position: absolute; right: 28px; top: 52px; bottom: 104px; width: min(372px, 40vw); overflow: hidden; display: flex; flex-direction: column; }
#flow .info .scroll { flex: 1; min-height: 0; overflow-y: auto; padding: 14px 20px 10px; display: flex; flex-direction: column; }
#flow .info .foot { padding: 0 20px 14px; }
#flow .info .foot .btns { margin-top: 10px; }
#flow .fname { font-size: clamp(22px, 2.9vw, 32px); font-weight: 900; font-style: italic; text-transform: uppercase; letter-spacing: 0.02em; line-height: 0.98; overflow-wrap: anywhere; }
#flow .fnick { font-size: 11px; font-weight: 700; letter-spacing: 0.24em; text-transform: uppercase; color: color-mix(in srgb, var(--c) 60%, #fff); margin-top: 6px; }
#flow .fmeta { font-size: 12px; color: #fffc; margin-top: 8px; line-height: 1.5; }
#flow .vitals { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; margin-top: 10px; }
#flow .vitals div { background: #fff1; padding: 6px 8px 5px; }
#flow .vitals b { display: block; font-size: 16px; font-weight: 800; font-variant-numeric: tabular-nums; }
#flow .vitals span { font-size: 8px; letter-spacing: 0.24em; text-transform: uppercase; color: #fff9; }
#flow .ratings { margin-top: 12px; display: grid; grid-template-columns: 66px 1fr 26px; gap: 5px 8px; font-size: 9px; letter-spacing: 0.18em; text-transform: uppercase; color: #fffb; align-items: center; }
#flow .ratings .bar, #flow .cond .bar { height: 7px; background: #0009; border: 1px solid #fff3; }
#flow .ratings .fill, #flow .cond .fill { height: 100%; background: var(--c); }
#flow .ratings i { font-style: normal; text-align: right; font-size: 11px; letter-spacing: 0; font-variant-numeric: tabular-nums; color: #fff; }
#flow .style { margin-top: 12px; padding-top: 10px; border-top: 1px solid #fff2; }
#flow .style .sname { font-size: 13px; font-weight: 800; letter-spacing: 0.16em; text-transform: uppercase; color: color-mix(in srgb, var(--c) 60%, #fff); }
#flow .style .blurb { font-size: 12px; line-height: 1.4; margin-top: 4px; color: #fff; }
#flow .style ul { margin: 7px 0 0; padding: 0; list-style: none; }
#flow .style li { font-size: 11.5px; line-height: 1.38; color: #fffc; padding-left: 12px; position: relative; margin-top: 3px; }
#flow .style li::before { content: ""; position: absolute; left: 0; top: 0.55em; width: 5px; height: 2px; background: var(--c); }
#flow .opts { padding-top: 6px; border-top: 1px solid #fff2; }
#flow .opt { display: grid; grid-template-columns: 78px 1fr; align-items: center; gap: 8px; margin-top: 5px; font-size: 9px; letter-spacing: 0.2em; text-transform: uppercase; color: #fff9; padding: 2px 4px; border-left: 2px solid #0000; }
#flow .opt.row { border-left-color: var(--gold); color: #fff; }
#flow .opt .choices { display: flex; gap: 4px; }
#flow .opt .ch { pointer-events: auto; cursor: pointer; flex: 1; padding: 6px 2px; text-align: center; font-size: 10px; font-weight: 700; letter-spacing: 0.08em; background: #fff1; border: 1px solid #fff2; color: #fffc; white-space: nowrap; }
#flow .opt .ch.sel { background: var(--gold); border-color: #fff2c0; color: #1a1206; }

/* the strip of name plates */
#flow .strip { position: absolute; left: 28px; right: 28px; bottom: 40px; display: flex; gap: 5px; }
#flow .strip.row .plate.sel { box-shadow: 0 0 0 1px var(--c), 0 6px 18px #000a; }
#flow .plate { pointer-events: auto; cursor: pointer; flex: 1 1 0; min-width: 0; padding: 0 6px 7px; background: #0a0a0ed9; border: 1px solid #fff2; transition: transform .1s; }
#flow .plate .sw { height: 4px; margin: 0 -6px 7px; background: linear-gradient(90deg, var(--c) 70%, var(--c2) 70%); }
#flow .plate .pn { font-size: clamp(10px, 1.15vw, 13px); font-weight: 900; font-style: italic; text-transform: uppercase; letter-spacing: 0.02em; line-height: 1.05; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#flow .plate .ps { font-size: 8px; letter-spacing: 0.16em; text-transform: uppercase; color: #fff8; margin-top: 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#flow .plate.sel { transform: translateY(-6px); border-color: var(--c); background: #16161cf2; }
#flow .plate.off { opacity: 0.32; cursor: default; }
#flow .plate.rung { cursor: default; }
#flow .plate.won { opacity: 0.5; } #flow .plate.won .pn { text-decoration: line-through; }
#flow .plate i { font-style: normal; color: var(--gold); margin-right: 6px; }
#flow .shead { position: sticky; top: -18px; z-index: 1; display: flex; align-items: center; justify-content: space-between; margin: -18px -22px 0; padding: 14px 22px 8px; background: #0a0a0e; }
#flow .shead h2 { margin: 0; } #flow .shead .btns { margin: 0; }

/* ladder */
#flow .tag { display: inline-block; font-size: 9px; font-weight: 800; letter-spacing: 0.2em; text-transform: uppercase; padding: 3px 7px; background: var(--gold); color: #1a1206; margin-bottom: 8px; align-self: flex-start; }

/* gym, controls: a sheet */
#flow .sheet { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); width: min(880px, 94vw); max-height: 90vh; padding: 18px 22px; overflow-y: auto; }
#flow .sheet h2 { margin: 0 0 4px; font-size: 22px; font-weight: 900; font-style: italic; text-transform: uppercase; letter-spacing: 0.03em; }
#flow .sheet .sub { font-size: 11px; color: #fffa; margin-bottom: 12px; line-height: 1.4; }
#flow .drills { display: flex; flex-direction: column; gap: 5px; }
#flow .ditem { pointer-events: auto; cursor: pointer; display: grid; grid-template-columns: 26px 1fr; gap: 2px 10px; padding: 9px 12px; background: #fff1; border-left: 3px solid #0000; }
#flow .ditem.sel, #flow .ditem:hover { background: #fff2; border-left-color: var(--gold); }
#flow .ditem .n { grid-row: 1 / 4; font-size: 20px; font-weight: 900; font-style: italic; color: var(--gold); line-height: 1; }
#flow .ditem .t { font-size: 14px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.06em; }
#flow .ditem .g { font-size: 12px; color: #fffd; line-height: 1.35; }
#flow .ditem .c { font-size: 10.5px; color: var(--gold); line-height: 1.35; }
#flow .ctl h3 { margin: 12px 0 5px; font-size: 10px; letter-spacing: 0.3em; text-transform: uppercase; color: var(--gold); font-weight: 700; }
#flow .ctl table { width: 100%; border-collapse: collapse; font-size: 12px; }
#flow .ctl th { font-size: 8.5px; letter-spacing: 0.22em; text-transform: uppercase; color: #fff8; font-weight: 700; text-align: left; padding: 3px 8px; }
#flow .ctl td { padding: 4px 8px; border-top: 1px solid #fff1; vertical-align: top; line-height: 1.35; color: #fffd; }
#flow .ctl td.k { font-weight: 800; white-space: nowrap; color: #fff; }
#flow .ctl .ctl-moves td:nth-child(2) { color: #f3dc8f; width: 30%; }
#flow .ctl .note { font-size: 11.5px; line-height: 1.45; color: #fffb; margin: 8px 0 0; }
#flow .ctl .note b { color: #fff; }

/* ring walk */
#flow .screen.walk { pointer-events: auto; }
#flow .namecard { position: absolute; left: clamp(14px, 5vw, 70px); bottom: 13%; min-width: 300px; max-width: 88vw; background: linear-gradient(90deg, #08080cf2 70%, #08080c99); border-left: 8px solid var(--c); box-shadow: 0 10px 30px #000a; padding: 12px 26px 12px 18px; }
#flow .namecard::after { content: ""; position: absolute; left: 0; right: 0; bottom: -4px; height: 4px; background: linear-gradient(90deg, var(--c2) 55%, #0000); }
#flow .namecard .fname { font-size: clamp(26px, 4.4vw, 46px); }
#flow .namecard .line { font-size: 12px; letter-spacing: 0.12em; text-transform: uppercase; color: #fffd; margin-top: 8px; }
#flow .tapecard { position: absolute; left: 50%; bottom: 7%; transform: translateX(-50%); width: min(760px, 94vw); display: grid; grid-template-columns: 1fr 96px 1fr; align-items: center; gap: 3px 14px; padding: 12px 22px 12px; background: linear-gradient(#08080ce6, #050507f2); border-top: 2px solid var(--gold); box-shadow: 0 10px 30px #000a; }
#flow .tapecard .l { text-align: right; } #flow .tapecard .r { text-align: left; }
#flow .tapecard .fname { font-size: clamp(16px, 2.8vw, 28px); }
#flow .tapecard .l .fname { border-right: 5px solid var(--ca); padding-right: 10px; } #flow .tapecard .r .fname { border-left: 5px solid var(--cb); padding-left: 10px; }
#flow .tapecard .vs { text-align: center; font-size: 24px; font-weight: 900; font-style: italic; color: var(--gold); }
#flow .tapecard .lbl { text-align: center; font-size: 8px; letter-spacing: 0.3em; color: #fff8; }
#flow .tapecard .val { font-size: 13px; font-weight: 700; font-variant-numeric: tabular-nums; }
#flow .tapecard .bout { grid-column: 1 / -1; text-align: center; font-size: 10px; letter-spacing: 0.3em; color: var(--gold); margin-top: 6px; }

/* in the fight */
#flow .third { position: absolute; left: 50%; top: 16%; transform: translateX(-50%); padding: 8px 30px; background: linear-gradient(#000c, #000e); border-top: 1px solid var(--gold); border-bottom: 1px solid var(--gold);
  font-size: 16px; font-weight: 900; font-style: italic; letter-spacing: 0.2em; text-transform: uppercase; opacity: 0; transition: opacity .35s; white-space: nowrap; }
#flow .third.on { opacity: 1; }
#flow .bug { position: absolute; left: 22px; top: 20px; padding: 5px 12px 4px; font-size: 11px; font-weight: 800; letter-spacing: 0.34em; background: #000b; border-left: 3px solid var(--gold); color: #f3dc8f; display: none; }
#flow .bug.on { display: block; }
#flow .skipzone { position: absolute; inset: 0; pointer-events: auto; display: none; }
#flow .skipzone.on { display: block; }
#flow .pausebtn { position: absolute; right: 10px; top: 10px; width: 34px; height: 34px; pointer-events: auto; cursor: pointer; display: none; align-items: center; justify-content: center; font-size: 12px; font-weight: 900; letter-spacing: 2px; color: #fffc; background: #0008; border: 1px solid #fff4; border-radius: 50%; z-index: 2; }
#flow.touch .pausebtn.on { display: flex; }
#flow .corner { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); width: min(820px, 95vw); max-height: 94vh; overflow-y: auto; padding: 16px 22px 14px; display: none; border-top-color: var(--gold); }
#flow .corner.on { display: block; }
#flow .corner .top { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
#flow .corner .big { font-size: clamp(22px, 3.4vw, 34px); font-weight: 900; font-style: italic; text-transform: uppercase; line-height: 1; }
#flow .corner .nextup { font-size: 10px; letter-spacing: 0.3em; text-transform: uppercase; color: var(--gold); white-space: nowrap; }
#flow .cgrid { display: grid; grid-template-columns: 1fr minmax(120px, auto) 1fr; gap: 3px 16px; margin-top: 12px; align-items: center; }
#flow .cgrid .nm { font-size: 15px; font-weight: 900; font-style: italic; text-transform: uppercase; line-height: 1; padding-bottom: 5px; border-bottom: 3px solid var(--c); overflow-wrap: anywhere; }
#flow .cgrid .l { text-align: right; } #flow .cgrid .r { text-align: left; }
#flow .cgrid .v { font-size: 15px; font-weight: 800; font-variant-numeric: tabular-nums; }
#flow .cgrid .lbl { text-align: center; font-size: 8.5px; letter-spacing: 0.26em; text-transform: uppercase; color: #fff9; white-space: nowrap; }
#flow .cgrid .gap { grid-column: 1 / -1; height: 8px; }
#flow .cond .bar { position: relative; }
#flow .cond.l .fill { margin-left: auto; }
#flow .cond.bad .fill { background: #c8402c; }
#flow .advice { margin-top: 12px; padding: 9px 12px; background: #fff1; border-left: 3px solid var(--gold); font-size: 13px; line-height: 1.4; }
#flow .advice span { display: block; font-size: 8px; letter-spacing: 0.3em; text-transform: uppercase; color: var(--gold); margin-bottom: 3px; }
#flow .corner .foot { display: flex; align-items: center; justify-content: space-between; margin-top: 10px; font-size: 10px; letter-spacing: 0.24em; text-transform: uppercase; color: #fff9; }
#flow .corner .count { font-size: 22px; font-weight: 800; color: #f3dc8f; font-variant-numeric: tabular-nums; letter-spacing: 0; }
#flow .pause { position: absolute; inset: 0; background: #000a; pointer-events: auto; display: none; }
#flow .pause.on { display: block; }
#flow .pause .box { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); width: 280px; padding: 18px 22px 20px; border-top-color: var(--gold); }
#flow .pause .box h2 { margin: 0 0 4px; font-size: 24px; font-weight: 900; font-style: italic; text-transform: uppercase; }
#flow .pause .menu { width: auto; margin-top: 14px; }
#flow .drill { position: absolute; left: 14px; top: 14px; width: min(330px, 62vw); padding: 10px 14px 10px; display: none; border-top-color: var(--gold); pointer-events: none; }
#flow .drill.on { display: block; }
#flow .drill .t { font-size: 13px; font-weight: 800; letter-spacing: 0.1em; text-transform: uppercase; }
#flow .drill .g { font-size: 11.5px; line-height: 1.35; color: #fffd; margin-top: 3px; }
#flow .drill .prog { height: 4px; background: #0009; border: 1px solid #fff3; margin-top: 8px; }
#flow .drill .prog div { height: 100%; background: var(--gold); width: 0; }
#flow .drill .s { font-size: 12px; font-weight: 700; margin-top: 5px; font-variant-numeric: tabular-nums; color: #f3dc8f; }
#flow .drill .k { font-size: 9px; letter-spacing: 0.2em; text-transform: uppercase; color: #fff8; margin-top: 6px; }
#flow .drill .back { pointer-events: auto; cursor: pointer; }

/* results */
#flow .screen.results .sheet { top: auto; bottom: 16px; transform: translateX(-50%); width: min(940px, 96vw); max-height: 78vh; display: grid; grid-template-columns: 1fr 1fr; gap: 0 26px; padding: 16px 22px 16px; border-top-color: var(--c); }
#flow .winner { font-size: clamp(24px, 3.6vw, 40px); font-weight: 900; font-style: italic; text-transform: uppercase; letter-spacing: 0.01em; line-height: 0.98; overflow-wrap: anywhere; }
#flow .method { margin-top: 6px; font-size: 11px; letter-spacing: 0.28em; text-transform: uppercase; color: var(--gold); }
#flow table.cards { margin-top: 12px; border-collapse: collapse; font-size: 13px; font-variant-numeric: tabular-nums; width: 100%; }
#flow table.cards th, #flow table.cards td { padding: 4px 8px; text-align: center; border-bottom: 1px solid #fff2; }
#flow table.cards th { font-size: 8.5px; letter-spacing: 0.22em; color: #fff8; font-weight: 700; }
#flow table.cards td.n { text-align: left; font-weight: 800; font-style: italic; text-transform: uppercase; font-size: 12px; max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#flow table.cards td.t { font-weight: 800; color: var(--gold); }
#flow .cardnote { font-size: 10px; color: #fff9; margin-top: 6px; line-height: 1.4; }
#flow .sgrid { display: grid; grid-template-columns: 1fr auto 1fr; gap: 1px 14px; align-items: center; align-content: start; }
#flow .sgrid .nm { font-size: 11px; font-weight: 900; font-style: italic; text-transform: uppercase; padding-bottom: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#flow .sgrid .l { text-align: right; } #flow .sgrid .r { text-align: left; }
#flow .sgrid .v { font-size: 13px; font-weight: 700; font-variant-numeric: tabular-nums; }
#flow .sgrid .lbl { text-align: center; font-size: 8px; letter-spacing: 0.24em; text-transform: uppercase; color: #fff9; white-space: nowrap; }
#flow .sgrid .rule { grid-column: 1 / -1; height: 1px; background: #fff2; margin: 3px 0; }

/* champion */
#flow .champ { position: absolute; right: clamp(16px, 4vw, 60px); top: 50%; transform: translateY(-50%); max-width: min(520px, 90vw); padding: 20px 26px; }
#flow .champ .big { font-size: clamp(40px, 7vw, 84px); font-weight: 900; font-style: italic; text-transform: uppercase; line-height: 0.9; color: #f3dc8f; text-shadow: 0 3px 0 #000; }

/* a short desktop window */
@media (max-height: 660px) and (min-width: 641px) {
  #flow .vitals { margin-top: 7px; } #flow .vitals b { font-size: 14px; } #flow .vitals div { padding: 4px 8px 3px; }
  #flow .ratings { margin-top: 8px; gap: 2px 8px; } #flow .fmeta { margin-top: 5px; }
  #flow .style { margin-top: 8px; padding-top: 7px; } #flow .style li { margin-top: 1px; font-size: 11px; } #flow .style .blurb { font-size: 11.5px; }
  #flow .opt { margin-top: 3px; } #flow .opt .ch { padding: 4px 2px; }
  #flow .info .foot .btns { margin-top: 7px; } #flow .info .btn { padding: 8px 16px; }
  #flow .fname { font-size: clamp(20px, 2.6vw, 28px); }
}
/* a phone held upright */
@media (max-width: 640px) {
  #flow .head { top: 10px; font-size: 10px; letter-spacing: 0.3em; }
  #flow .info { left: 8px; right: 8px; top: auto; bottom: 8px; width: auto; max-height: 42vh; }
  #flow .screen.title { background: linear-gradient(#000b, #0005 45%, #0003 70%, #000a); }
  #flow .champ { left: 8px; right: 8px; top: auto; bottom: 8px; transform: none; max-width: none; }
  #flow .info .scroll { padding: 10px 14px 8px; } #flow .info .foot { padding: 0 14px 10px; }
  #flow .strip { left: 8px; right: 8px; top: 34px; bottom: auto; overflow-x: auto; }
  #flow .plate { flex: 0 0 92px; } #flow .plate.sel { transform: none; }
  #flow .hint { display: none; }
  #flow .menu { width: 210px; }
  #flow .screen.results .sheet { grid-template-columns: 1fr; gap: 12px; max-height: 70vh; }
  #flow .namecard { min-width: 0; bottom: 22%; }
  #flow .tapecard { grid-template-columns: 1fr 64px 1fr; padding: 10px; }
  #flow .cgrid { gap: 3px 8px; } #flow .cgrid .nm { font-size: 12px; }
  #flow .ctl table { font-size: 11px; } #flow .ctl td { padding: 4px 4px; }
  #flow .sheet { padding: 14px 12px; }
}
/* a phone on its side: short */
@media (max-height: 460px) and (min-width: 641px) {
  #flow .head { top: 10px; }
  #flow .info { top: 34px; bottom: 62px; }
  #flow .info .scroll { padding: 8px 14px 6px; } #flow .info .foot { padding: 0 14px 8px; }
  #flow .strip { bottom: 8px; }
  #flow .hint { display: none; }
  #flow .wordmark { font-size: 54px; } #flow .menu { margin-top: 14px; gap: 5px; } #flow .menu .btn { padding: 8px 16px; }
  #flow .style li { margin-top: 1px; } #flow .ratings { gap: 3px 8px; margin-top: 8px; }
  #flow .screen.results .sheet { max-height: 92vh; bottom: 6px; }
}
`;
