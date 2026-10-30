import {it} from 'vitest';
import {readFileSync,writeFileSync} from 'node:fs';
import {broadcastStatsSchema, type BroadcastStats} from '@mizar/protocol/broadcast-stats';
import {programPresentationSchema, type ProgramSceneId} from '@mizar/protocol/program-scenes';
import type {MatchContextBinding} from '../src/match-context/lkg-store.js';
import {projectHistoricalProgram} from '../src/projections/historical-program.js';
it('renders synthetic phase fixture',()=>{
 const raw=broadcastStatsSchema.parse(JSON.parse(readFileSync('tests/fixtures/rivalhub-provider-stats-v1-extended.json','utf8')));
 const team=(e:BroadcastStats['entrants'][number])=>({entryId:e.entryId,name:e.name,logoUrl:e.logoUrl,players:e.starters.map(p=>({playerId:p.userId,displayName:p.nickname,avatarUrl:p.avatarUrl,isStarter:true}))});
 const manifest=(e:BroadcastStats['entrants'][number])=>({entryId:e.entryId,roster:{players:e.starters.map(p=>({playerId:p.userId,isStarter:true}))}});
 const binding={origin:'online',context:{matchId:raw.matchId,competition:{competitionId:raw.competitionId},mapPool:raw.mapPool??[],entrants:{a:team(raw.entrants[0]!),b:team(raw.entrants[1]!)}},manifest:{match:{matchId:raw.matchId},entrants:{a:manifest(raw.entrants[0]!),b:manifest(raw.entrants[1]!)}}} as unknown as MatchContextBinding;
 const metric={value:null,basis:{source:'gsi',window:'map-scoreboard',definition:'scoreboard-count.v1',rounds:null,coverage:'unavailable'},reason:'missing-input'};
 const stat={scoreboard:{kills:metric,assists:metric,deaths:metric,kdRatio:metric},completed:{adr:metric,kastPercent:metric,impactApprox:metric,rating2Approx:metric},includingCurrentRound:{adr:metric},currentRound:{damage:metric,moneySpent:metric}};
 const people=(side:number)=>raw.entrants[side]!.starters.map((p,i)=>({id:p.userId,name:p.nickname,avatarUrl:p.avatarUrl,kills:12+i,assists:3+i,deaths:7+i,statistics:stat}));
 const summary={matchId:raw.matchId,mapOrder:1,mapName:'de_dust2',cursor:{producerInstanceId:'test',liveSessionId:null,runtimeSeq:1,programSourceGeneration:0,programReceiveSequence:null,mapEpoch:1},score:{a:13,b:5},players:{a:people(0),b:people(1)}};
 const program=programPresentationSchema.parse({schemaVersion:'mizar.program-presentation.v2',packageId:'builtin:mizar-default',match:{matchId:raw.matchId,competition:null,format:'bo3',stage:null},series:{format:'bo3',requiredWins:2,entrants:{a:{entryId:raw.entrants[0]!.entryId,name:raw.entrants[0]!.name,logoUrl:null},b:{entryId:raw.entrants[1]!.entryId,name:raw.entrants[1]!.name,logoUrl:null}},score:{a:1,b:0},status:'completed',bindingState:'bound',currentMapOrder:null,maps:[{mapId:null,mapOrder:1,mapName:'de_dust2',selection:{kind:'decider'},teamAStartSide:null,status:'completed',finalScore:{a:13,b:5},winnerEntryId:raw.entrants[0]!.entryId}],veto:[{stepOrder:1,actionType:'ban',mapName:'de_nuke',entryId:raw.entrants[0]!.entryId,side:null}],roundHistory:null},halftime:summary,completed:[summary],eventLogoUrl:null,scheduledAt:null,previous:null,next:null});
 for(const scene of ['bp','halftime','intermap','match_result'] as ProgramSceneId[]){const out=projectHistoricalProgram(binding,raw,program,scene);out.history=[null,null];writeFileSync(`apps/web/__issue111_review-phase-${scene}.json`,JSON.stringify(out));}
 const empty=projectHistoricalProgram(binding,null,null,'waiting');writeFileSync('apps/web/__issue111_review-phase-maps-info.json',JSON.stringify(empty));
});
