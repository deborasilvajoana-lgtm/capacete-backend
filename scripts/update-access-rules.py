from pathlib import Path
import json
p=Path(__file__).resolve().parents[1]/'firebase-database.rules.json'
r=json.loads(p.read_text())['rules']
profile="root.child('users').child(auth.uid).child('profile')"
def membership(cid):return f"root.child('users').child(auth.uid).child('companies').child({cid})"
def allowed(cid,roles=None):
 m=membership(cid);legacy=f"{profile}.child('companyId').val() === {cid}"
 access=f"({m}.exists() ? {m}.child('enabled').val() === true : {legacy})"
 if roles:
  mr=' || '.join(f"{m}.child('role').val() === '{v}'" for v in roles)
  pr=' || '.join(f"{profile}.child('role').val() === '{v}'" for v in roles)
  access=f"({access} && ({m}.exists() ? ({mr}) : ({pr})))"
 return f"(auth != null && {profile}.child('enabled').val() !== false && ({profile}.child('platformAdmin').val() === true || {access}))"
cid='$companyId';company=r['companies'][cid]
authorized=f"(root.child('authorizedUsers').child(auth.uid).val() === true || root.child('authorizedUsers').child(auth.uid).child('enabled').val() === true)"
selfNew=f"(auth != null && {profile}.child('enabled').val() !== false && {authorized} && $companyId.beginsWith('self_' + auth.uid + '_') && !{membership(cid)}.exists())"
r['companies']['.read']=f"auth != null && {profile}.child('enabled').val() !== false && {profile}.child('platformAdmin').val() === true"
company['.write']=False
company['profile']['.read']=allowed(cid)+f" || {selfNew}"
company['profile']['.write']=allowed(cid,['admin'])+f" || ({selfNew} && !data.exists())"
for key in ['employees','worksites','helmets','trainings']:
 company[key]['.read']=allowed(cid)
 for child,v in company[key].items():
  if isinstance(v,dict) and child.startswith('$'):v['.write']=allowed(cid,['admin','sst'])
company['asos']['.read']=allowed(cid,['admin','sst'])
for child,v in company['asos'].items():
 if isinstance(v,dict):v['.write']=allowed(cid,['admin','sst'])
for key,roles in [('settings',['admin','sst']),('monitoring',None),('alerts',None),('members',['admin']),('audit',['admin','sst'])]:
 company[key]['.read']=allowed(cid,roles)
 if key=='settings':company[key]['.write']=allowed(cid,['admin','sst'])
company['monitoring']['.write']=False
company['members']['.write']=False
company['members']['$uid']['.write']=allowed(cid,['admin'])+f" || ({selfNew} && $uid === auth.uid && !data.exists() && newData.child('enabled').val() === true && newData.child('role').val() === 'admin')"
userCompany=r['users']['$uid']['companies'][cid]
userCompany['.write']=allowed(cid,['admin'])+f" || ({selfNew} && $uid === auth.uid && !data.exists() && newData.child('enabled').val() === true && newData.child('role').val() === 'admin')"
# Keep immutable alert fields and restrict acknowledgement to the company's role.
alert=company['alerts']['$alertId']
old=alert['.write'];tail=old[old.index(" && newData.child('acknowledged').val()") :]
oldName=f"{profile}.child('displayName').val()"
memberName="root.child('companies').child($companyId).child('members').child(auth.uid).child('displayName')"
tail=tail.replace(oldName,f"({memberName}.exists() ? {memberName}.val() : {oldName})")
alert['.write']=allowed(cid,['admin','sst','supervisor'])+' && data.exists()'+tail
registry=r['deviceRegistry']['$deviceId'];oldcid="data.child('companyId').val()";newcid="newData.child('companyId').val()"
registry['.read']=allowed(oldcid)
registry['.write']=f"((!data.exists() || {allowed(oldcid,['admin','sst'])}) && (!newData.exists() || {allowed(newcid,['admin','sst'])}))"
for k in ['devices','ultimo','resumo','eventos']:
 r[k]['.read']=f"auth != null && {profile}.child('enabled').val() !== false && {authorized} && (!{profile}.child('companyId').exists() || {profile}.child('companyId').val() === '' || {profile}.child('platformAdmin').val() === true)"
p.write_text(json.dumps({'rules':r},indent=2)+'\n')
print('Company-scoped access rules regenerated')
