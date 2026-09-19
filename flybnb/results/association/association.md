# Association: 600 unrelated founders, 957051 candidate connections, 71 phenotypes

Cross-validated R² from the connections INTO the readout cells: median 0.40. From the rest of the active network WITHOUT them: median -0.12. From every candidate connection of the stimulus (the 200 most correlated, chosen inside each training fold): median 0.17 (7% of phenotypes above 0.5). The direct connections give at least half of that in 87% of phenotypes.

**Ignition is an individual phenotype.** Fraction of individuals in which a stimulus tips the network into its high-activity state (> 3,000 neurons active): sound 0%; sound_left 0%; sound_gate 0%; wind 2%; sugar 2%; bitter 3%; taste_peg 2%; head_bristle 5%; eye_bristle 2%; ocelli 0%; moist 27%; pheromone 100%; cold 100%. The connection-level analysis below covers the stimuli under which nobody ignites; for the others the candidate set is the whole ignited network (wind 435,631, sugar 429,640, bitter 317,015, taste_peg 330,166, head_bristle 504,422, eye_bristle 198,757, moist 622,459 connections) and the question is a different one.

Significant connections per phenotype (FDR 0.05): median 7; 61% of all significant connections are direct inputs of the readout.

| stimulus | readout | mean ± SD | R² direct | R² all | significant (direct) | strongest connection |
|---|---|---|---|---|---|---|
| ocelli | DNge125 | 8.1 ± 6.1 | 0.74 | 0.73 | 2 (1) | DNb06 → DNge125 (base 40, r +0.86) |
| sound_gate | DNge130 | 10.3 ± 4.9 | 0.94 | 0.65 | 9 (9) | JO-A2 → DNge130 (base 16, r +0.42) |
| sound | DNge113 | 8.0 ± 5.3 | 0.91 | 0.61 | 10 (10) | JO-B1_b → DNge113 (base 15, r +0.47) |
| ocelli | DNp19 | 21.5 ± 9.5 | 0.15 | 0.56 | 20 (5) | untyped → OCG02b (base 7, r +0.30) |
| ocelli | DNp28 | 80.3 ± 6.8 | 0.99 | 0.52 | 24 (23) | untyped → DNp28 (base 6, r +0.23) |
| ocelli | DNp20 | 32.3 ± 12.9 | 0.50 | 0.49 | 12 (4) | OCG01e → DNp20 (base 242, r +0.40) |
| sound_left | DNb05 | 22.4 ± 5.2 | 0.79 | 0.49 | 8 (7) | JO-B4_b → DNb05 (base 16, r +0.45) |
| ocelli | DNb06 | 73.6 ± 10.9 | 0.55 | 0.46 | 9 (6) | OCG01e → DNb06 (base 339, r +0.46) |
| sound_left | DNge091 | 6.5 ± 4.5 | 0.83 | 0.46 | 7 (5) | JO-B4_b → DNge091 (base 17, r +0.60) |
| ocelli | DNpe017 | 74.6 ± 14.9 | 0.49 | 0.45 | 8 (6) | OCG01d → DNpe017 (base 191, r +0.41) |
| ocelli | DNp18 | 72.3 ± 11.4 | 0.40 | 0.41 | 10 (4) | OCG01e → DNp18 (base 357, r +0.45) |
| ocelli | DNp16 | 7.4 ± 6.1 | 0.65 | 0.41 | 5 (4) | OCG01d → DNp16 (base 25, r +0.57) |
| sound_left | DNge145 | 2.8 ± 3.3 | 0.80 | 0.41 | 4 (4) | JO-B4_b → DNge145 (base 32, r +0.71) |
| sound_gate | DNge113 | 3.1 ± 3.6 | 0.80 | 0.37 | 12 (11) | JO-B1_b → DNge113 (base 11, r +0.42) |
| sound_left | DNg99 | 5.4 ± 3.9 | 0.61 | 0.35 | 4 (4) | JO-B4_b → DNg99 (base 12, r +0.54) |
| sound | DNge145 | 10.0 ± 5.9 | 0.86 | 0.35 | 9 (9) | JO-B4_b → DNge145 (base 32, r +0.38) |
| sound_gate | DNge091 | 5.2 ± 4.1 | 0.74 | 0.33 | 5 (5) | JO-B4_b → DNge091 (base 17, r +0.59) |
| ocelli | DNge070 | 3.2 ± 4.1 | 0.57 | 0.30 | 4 (3) | OCG01d → DNge070 (base 24, r +0.59) |
| sound | DNge130 | 7.9 ± 5.1 | 0.74 | 0.29 | 9 (9) | JO-A4 → DNge130 (base 17, r +0.37) |
| sound_gate | DNp01 | 22.2 ± 6.2 | 0.75 | 0.29 | 13 (11) | JO-A5 → DNp01 (base 15, r +0.35) |
| sound | DNge091 | 4.9 ± 4.1 | 0.75 | 0.27 | 5 (5) | JO-B4_b → DNge091 (base 17, r +0.59) |
| sound_gate | DNg99 | 8.9 ± 5.3 | 0.69 | 0.27 | 6 (6) | JO-B4_b → DNg99 (base 12, r +0.49) |
| sound_left | DNp12 | 28.1 ± 6.2 | 0.56 | 0.24 | 10 (9) | CB2789 → DNp12 (base 20, r +0.27) |
| sound_gate | DNpe017 | 4.4 ± 4.1 | 0.37 | 0.24 | 7 (1) | CB0478 → DNpe017 (base 95, r +0.63) |
| sound | DNpe017 | 4.0 ± 4.0 | 0.35 | 0.23 | 7 (1) | CB0478 → DNpe017 (base 95, r +0.62) |
| sound_gate | DNp40 | 6.4 ± 4.5 | 0.35 | 0.23 | 5 (1) | CB0478 → DNp40 (base 102, r +0.61) |
| sound | DNg99 | 9.9 ± 5.5 | 0.67 | 0.23 | 7 (6) | JO-B4_b → DNg99 (base 12, r +0.45) |
| sound_gate | DNpe014 | 26.3 ± 13.8 | 0.02 | 0.22 | 13 (1) | JO-B2 → CB0478 (base 11, r +0.30) |
| sound | DNpe014 | 24.7 ± 13.9 | 0.02 | 0.22 | 15 (1) | JO-B2 → CB0478 (base 11, r +0.31) |
| sound_gate | DNge141 | 3.4 ± 3.7 | 0.51 | 0.21 | 5 (3) | CB2556 → DNge141 (base 27, r +0.54) |
| sound_left | DNg29 | 8.2 ± 5.0 | 0.45 | 0.20 | 8 (5) | JO-A1 → DNg29 (base 40, r +0.43) |
| sound_left | DNg15 | 5.1 ± 4.0 | 0.08 | 0.18 | 7 (1) | CB2789 → CB0591 (base 29, r +0.42) |
| sound | DNp01 | 20.7 ± 6.6 | 0.60 | 0.18 | 8 (8) | JO-A5 → DNp01 (base 15, r +0.34) |
| sound | DNb05 | 22.7 ± 6.1 | 0.65 | 0.17 | 9 (8) | JO-B4_b → DNb05 (base 16, r +0.41) |
| sound_left | DNg56 | 26.5 ± 7.2 | 0.34 | 0.17 | 8 (6) | CB2789 → DNg56 (base 31, r +0.33) |
| sound_gate | DNge145 | 2.9 ± 3.3 | 0.63 | 0.17 | 10 (8) | JO-B1_b → DNge145 (base 12, r +0.31) |
| sound | DNge141 | 2.9 ± 3.4 | 0.42 | 0.17 | 8 (3) | CB2556 → DNge141 (base 27, r +0.51) |
| sound | DNp40 | 5.9 ± 4.5 | 0.33 | 0.16 | 4 (1) | CB0478 → DNp40 (base 102, r +0.58) |
| sound | DNb06 | 12.3 ± 6.5 | 0.14 | 0.16 | 5 (1) | CB0478 → DNb06 (base 177, r +0.42) |
| sound_gate | DNb06 | 13.2 ± 6.5 | 0.15 | 0.15 | 6 (1) | CB0478 → DNb06 (base 177, r +0.43) |
