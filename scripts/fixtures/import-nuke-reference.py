import json,hashlib,math,sys
from pathlib import Path
# Usage: python scripts/fixtures/import-nuke-reference.py <extracted cs2-demo-format directory>
src=Path(sys.argv[1]); out=Path('fixtures/demo/nuke-lgcy-flc-round-01');out.mkdir(parents=True,exist_ok=True)
load=lambda n:json.loads((src/n).read_text())
m=load('manifest.json');assert m['demo']['hash']=='2b08640110e8c619f1f2d711fe13772c039e7f668e3a43994f9d57b66f50b730';r=load('replay.json')['rounds'][0];meta=load('replay.json');people={p['steamId64']:p for p in load('players.json')};match=load('match.json');bombs=load('bombs.json');events=[b for b in bombs if b['roundNumber']==1];begin,plant,defstart,defend=events
# The export has no fuse netvar. Derive this offline example's countdown from
# the six observed planted→exploded event intervals in THIS demo (all 2624 ticks).
intervals=[b['tick']-next(p['tick'] for p in bombs if p['roundNumber']==b['roundNumber'] and p['type']=='planted') for b in bombs if b['type']=='exploded'];assert len(set(intervals))==1
fuse=intervals[0]; rate=m['tickrate'];start=begin['tick']-8
# Include exact event ticks, and authentic 8-tick player samples. At event ticks,
# position/HP are the immediately preceding sample, never interpolated/invented.
ticks=sorted(set([start]+list(range(r['startTick'],defend['tick'],r['tickStep']))+[e['tick'] for e in events]));ticks=[t for t in ticks if t>=start]
kills=load('kills.json')
rows=[]
for seq,t in enumerate(ticks,1):
 ix=min(r['frameCount']-1,max(0,(t-r['startTick'])//r['tickStep']));ps={}
 for slot,p in enumerate(sorted(r['players'],key=lambda p:(p['side']!='ct',p['steamId64']))):
  w=meta['weaponDict'][p['weapon'][ix]];yaw=math.radians(p['yaw'][ix]);state={'health':p['hp'][ix]}
  if p['steamId64']==defstart['actorSteamId64']:
   # Observed uninterrupted begin→complete =10s, hence no kit. No other
   # player's freeze-time equipment is asserted to remain current.
   state['defusekit']=False
  ps[p['steamId64']]={'name':people[p['steamId64']]['name'],'team':p['side'].upper(),'observer_slot':slot,'position':','.join(str(p[k][ix]) for k in ['x','y','z']),'forward':f'{math.cos(yaw)},{math.sin(yaw)},0','state':state,'weapons':{'weapon_0':{'name':'weapon_'+w,'state':'active'}}}
 for sid,p in ps.items():
  p.pop('weapons', None) # Export contains only the held item, not a complete inventory.
  past=[k for k in kills if k['tick']<=t]
  p['match_stats']={'kills':sum(k.get('killerSteamId64')==sid for k in past),'deaths':sum(k.get('victimSteamId64')==sid for k in past),'assists':sum(k.get('assisterSteamId64')==sid for k in past)}
  p['state']['round_kills']=p['match_stats']['kills']
 if t<begin['tick']:bs={'state':'carried','player':begin['actorSteamId64']}
 elif t<plant['tick']:bs={'state':'planting','player':begin['actorSteamId64'],'countdown':str((plant['tick']-t)/rate)}
 elif t<defstart['tick']:bs={'state':'planted','countdown':str((plant['tick']+fuse-t)/rate)}
 elif t<defend['tick']:bs={'state':'defusing','player':defstart['actorSteamId64'],'countdown':str((defend['tick']-t)/rate)}
 else:bs={'state':'defused'}
 bs['position']=','.join(str(plant['position'][k]) for k in ['x','y','z'])
 observed=defstart['actorSteamId64'] if t>=defstart['tick'] else begin['actorSteamId64']
 payload={'provider':{'name':'demo-derived-nuke-reference','appid':730,'version':1,'timestamp':t/rate},'map':{'name':'de_nuke','mode':'competitive','phase':'live','round':0,'team_ct':{'name':match['teamB']['name'],'score':int(t>=defend['tick'])},'team_t':{'name':match['teamA']['name'],'score':0}},'round':{'phase':'over' if t>=defend['tick'] else 'live'},'allplayers':ps,'player':dict(ps[observed],steamid=observed,activity='playing'),'bomb':bs}
 if t>=defend['tick']:payload['round']['win_team']='CT'
 rows.append({'version':1,'sequence':seq,'elapsedUs':round((t-start)/rate*1e6),'receivedAt':'2026-06-10T18:02:05.368Z','payload':payload})
raw=''.join(json.dumps(r,separators=(',',':'),sort_keys=True)+'\n' for r in rows);sha=hashlib.sha256(raw.encode()).hexdigest();(out/'frames.jsonl').write_text(raw)
manifest={'formatVersion':1,'captureId':'demo-derived-nuke-lgcy-flc-round-1','createdAt':'2026-06-10T18:02:05.368Z','platform':'offline-demo-export','broadcastCommit':'d1f90aa','scenario':'Nuke real demo round 1, protocol-shaped offline replay; not a GSI recording','gsiConfig':{},'complete':True,'frameCount':len(rows),'droppedFrames':0,'framesSha256':sha}
(out/'manifest.json').write_text(json.dumps(manifest))
provenance={'kind':'demo-derived','demoSha256':m['demo']['hash'],'sourceFileName':m['demo']['sourceFileName'],'tickrate':rate,'startTick':start,'endTick':defend['tick'],'explosionIntervalTicks':fuse,'notes':'Position/HP/held item from 8-tick samples; exact plant/defuse events. Explosion countdown uses same-demo 41s event interval, not a measured fuse netvar. Observer selected for inspection; money, armor, ammo and inventory absent, never invented.'}
(out/'demo-source.json').write_text(json.dumps(provenance,indent=2));print(len(rows),provenance)
