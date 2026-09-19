# Atlas, first slice: silencing under `sound`, base wiring against 100 individuals

Detection rule: all seeds agree in sign and mean |change| >= 1.0 spike. 361 effects detected on the base wiring (128 of them by silencing part of the stimulus).

**Replication of the 233 central effects:** median 0.18; 7% replicate in at least 80% of individuals, 53% in at most 20%. Deciles (0-10% ... 90-100%): [77, 45, 32, 17, 20, 7, 12, 7, 8, 8].

**Missed by the base:** 12 effects are detected in at least half of the individuals and not on the base wiring.

**Any individual as the brain studied** (central effects): 208 effects per individual (range 76-578); an effect found in one individual is found in another with probability 0.22 (median over effects 0.10; 7% in at least 80% of the others, 64% in at most 20%).

| size of the effect on the base (spikes) | effects | median replication | median same sign | replicate in >= 80% |
|---|---|---|---|---|
| 1-2 | 78 | 0.08 | 0.46 | 0% |
| 2-5 | 93 | 0.18 | 0.57 | 3% |
| 5-10 | 39 | 0.39 | 0.73 | 10% |
| >= 10 | 23 | 0.77 | 0.93 | 39% |

**What predicts replication (Spearman):** abs_base_effect +0.51, direct_synapses +0.48, effects_with_a_direct_connection 0.30, replication_with_direct 0.45, replication_without_direct 0.19

| silenced | readout | base effect | replication | same sign | mean ± SD over individuals |
|---|---|---|---|---|---|
| CB0478 | DNpe014 | -30.3 | 0.94 | 0.96 | -21.5 ± 14.4 |
| JO-B2 (stimulus) | DNpe014 | -29.7 | 0.94 | 0.96 | -17.0 ± 10.2 |
| DNg29 | DNg24 | -29.0 | 0.27 | 0.63 | -9.8 ± 11.3 |
| JO-A2 (stimulus) | DNg24 | -29.0 | 0.31 | 0.59 | -7.1 ± 9.8 |
| JO-A5 (stimulus) | DNg24 | -29.0 | 0.35 | 0.65 | -12.8 ± 13.5 |
| DNg29 | DNg56 | +22.0 | 0.90 | 0.99 | +12.0 ± 7.5 |
| DNg29 | DNp12 | +22.0 | 0.94 | 0.99 | +12.6 ± 8.7 |
| JO-B4_b (stimulus) | DNb05 | -20.0 | 1.00 | 1.00 | -21.4 ± 6.0 |
| CB3913 | DNg24 | -19.3 | 0.12 | 0.54 | -4.6 ± 7.9 |
| JO-A2 (stimulus) | DNg56 | +19.3 | 0.64 | 0.91 | +4.9 ± 4.5 |
| JO-A2 (stimulus) | DNp12 | +18.7 | 0.64 | 0.91 | +5.6 ± 5.4 |
| JO-B3 (stimulus) | DNg24 | -18.7 | 0.25 | 0.61 | -5.1 ± 7.1 |
| SAD013 | DNg56 | +17.0 | 0.85 | 0.96 | +10.4 ± 6.6 |
| JO-A5 (stimulus) | DNp01 | -16.0 | 0.97 | 1.00 | -14.3 ± 4.8 |
| CB0104 | DNg24 | -15.7 | 0.15 | 0.50 | -1.6 ± 3.1 |
| JO-A1 (stimulus) | DNg29 | -15.7 | 1.00 | 1.00 | -11.6 ± 5.1 |
| JO-A5 (stimulus) | DNg56 | +15.7 | 0.67 | 0.89 | +5.1 ± 4.3 |
| JO-A5 (stimulus) | DNp12 | +15.7 | 0.59 | 0.86 | +4.8 ± 4.8 |
| CB2162 | DNpe014 | +15.0 | 0.86 | 0.95 | +10.8 ± 8.0 |
| JO-B1_b (stimulus) | DNg24 | -15.0 | 0.09 | 0.48 | -2.1 ± 5.0 |
| SAD013 | DNp12 | +14.3 | 0.79 | 0.93 | +8.9 ± 6.5 |
| CB0033 | DNp12 | +14.0 | 0.95 | 1.00 | +8.0 ± 3.6 |
| JO-B3 (stimulus) | DNpe014 | +14.0 | 0.85 | 0.95 | +9.8 ± 6.6 |
| CB0478 | DNb06 | -13.7 | 0.94 | 0.99 | -11.0 ± 6.7 |
| JO-B3 (stimulus) | DNp12 | +13.7 | 0.70 | 0.87 | +5.5 ± 4.5 |
| JO-B3 (stimulus) | DNg56 | +13.3 | 0.63 | 0.86 | +4.6 ± 4.3 |
| cM01a | DNpe014 | -13.3 | 0.86 | 0.96 | -9.4 ± 6.7 |
| JO-B4_b (stimulus) | DNp12 | -13.0 | 0.95 | 1.00 | -20.2 ± 10.3 |
| JO-A4 (stimulus) | DNg24 | -12.3 | 0.23 | 0.57 | -1.3 ± 4.2 |
| JO-B1_b (stimulus) | DNp11 | -12.3 | 0.63 | 0.81 | -4.4 ± 4.2 |
| JO-B3 (stimulus) | DNp11 | -12.0 | 0.60 | 0.80 | -3.9 ± 3.9 |
| JO-B4_b (stimulus) | DNpe014 | -12.0 | 0.71 | 0.93 | -5.6 ± 4.1 |
| CB3913 | DNp12 | +11.7 | 0.44 | 0.75 | +4.2 ± 4.6 |
| JO-B1_b (stimulus) | DNg56 | +11.7 | 0.57 | 0.86 | +3.8 ± 4.0 |
| JO-B1_b (stimulus) | DNp12 | +11.7 | 0.64 | 0.87 | +3.9 ± 3.8 |
| JO-B1_b (stimulus) | DNpe014 | +11.7 | 0.83 | 0.95 | +10.0 ± 6.9 |
| JO-B2 (stimulus) | DNb06 | -11.7 | 0.93 | 0.99 | -8.0 ± 4.5 |
| JO-B4_a (stimulus) | DNp11 | -11.7 | 0.44 | 0.63 | -2.5 ± 4.4 |
| CB0517 | DNg56 | +11.3 | 0.77 | 0.96 | +4.6 ± 3.0 |
| JO-B4_b (stimulus) | DNg56 | -11.3 | 0.95 | 0.99 | -14.1 ± 8.2 |
