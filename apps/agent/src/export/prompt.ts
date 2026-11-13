export const ANALYSIS_PROMPT = `# OI Sniper analysis request

You are given an export from a crypto futures bot (USDT perpetuals, long only). Files:

- \`trades.csv\` / \`trades.jsonl\`: one row per position with the full signal snapshot (all CoinGlass timeframes),
  market conditions at entry (spread, depth, funding, 1m range), config at entry, execution quality,
  exit legs, PnL, MFE/MAE and price after exit (+15m, +1h, +4h).
- \`signals.csv\`: every rule match, including rejected ones, with gate values and counterfactual outcome.
- \`signals.jsonl\`: the same signals as nested JSON, with every variant's gate results and router candidates.
- \`strategy_versions.json\`: every config version referenced.
- \`summary.json\`: KPIs for this selection.
- \`DATA_DICTIONARY.md\`: meaning and unit of every column.

Please:

1. Find entry thresholds (OI change, volume change, price change per timeframe) that separate winners from losers.
   Report the threshold, the trade count on each side and the net PnL difference. Avoid overfitting: prefer rules
   that hold across exchanges and across weeks.
2. Compare leverage levels and trail variants (\`variant_id\`) on net PnL after fees and funding, win rate,
   profit factor and average ROE. Note where fees eat most of TP1.
3. Check exits: use MFE, \`after_exit.*\` and \`path.peak_roe\` to say whether TP1, lock and trail distance are
   too tight or too loose.
4. Check gates: for rejected signals, compare \`counterfactual.first_hit\` by reject reason. Say which gates save
   money and which cost money, and what threshold you would use instead.
5. Give a concrete new config (rules, leverage, exits, gates) as JSON in the same shape as \`strategy_versions.json\`,
   plus the expected effect and the risk that it is overfit.

Be explicit about sample sizes. Do not recommend a change backed by fewer than 30 trades without saying so.
`;
