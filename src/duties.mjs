// のくぷら運営用サーバーの担当ロール。名前の変更ではなく、ロールIDで照合する。
export const dutyRoles=[
  {name:'接客キャスト',role_id:'1571793405082734663'},
  {name:'サポートスタッフ',role_id:'1571793269334212648'},
  {name:'PA',role_id:'1571793454378385588'},
  {name:'照明',role_id:'1571793510280200264'},
  {name:'カメラ',role_id:'1571794443235885056'},
  {name:'星空解説',role_id:'1571794528447504465'},
  {name:'歌パフォーマンス',role_id:'1571794550069006376'},
  {name:'動画編集',role_id:'1571794566418407444'}
];

export function dutyOptions(member){
  const roles=new Set(member.roles||[]);
  return dutyRoles.map(duty=>({name:duty.name,available:roles.has(duty.role_id)}));
}
