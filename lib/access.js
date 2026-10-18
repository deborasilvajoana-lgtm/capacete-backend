'use strict';
function companyRole(profile={},membership,companyId){
  if(profile.enabled===false)return null;
  if(profile.platformAdmin===true)return 'admin';
  if(membership!==null&&membership!==undefined)return membership.enabled===true?String(membership.role||'viewer').toLowerCase():null;
  return profile.companyId===companyId?String(profile.role||'viewer').toLowerCase():null;
}
module.exports={companyRole};
