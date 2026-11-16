export const weekdays=['日','月','火','水','木','金','土'];
const clock=/^(?:[01]\d|2[0-3]):[0-5]\d$/;

export function validateRegularHours(value){
  if(value===null)return null;
  if(!value||typeof value!=='object'||Array.isArray(value)||![1,2].includes(value.interval_weeks)||!Number.isInteger(value.weekday)||value.weekday<0||value.weekday>6)throw new Error('開催ペースと曜日を選んでください。');
  if(typeof value.start_time!=='string'||typeof value.end_time!=='string'||!clock.test(value.start_time)||!clock.test(value.end_time)||value.start_time===value.end_time)throw new Error('開始・終了時刻を確認してください。同じ時刻は指定できません。');
  return {interval_weeks:value.interval_weeks,weekday:value.weekday,start_time:value.start_time,end_time:value.end_time};
}

export function regularHoursLabel(value){
  if(!value)return '';
  return `${value.interval_weeks===2?'隔週':'毎週'}${weekdays[value.weekday]}曜日 ${value.start_time}〜${value.end_time<value.start_time?'翌':''}${value.end_time}`;
}

export function jstTime(value){
  const date=new Date(value);
  return Number.isFinite(date.getTime())?new Date(date.getTime()+9*3600000).toISOString().slice(11,16):'';
}

export function attendanceTimes(answer,event,regularHours){
  if(answer)return {available_from:answer.available_from??'',available_until:answer.available_until??''};
  return {available_from:regularHours?.start_time||jstTime(event?.starts_at),available_until:regularHours?.end_time||jstTime(event?.ends_at)};
}

export function newEventTimes(regularHours,now=new Date()){
  if(!regularHours)return {};
  const hours=validateRegularHours(regularHours),jst=new Date(now.getTime()+9*3600000);
  jst.setUTCDate(jst.getUTCDate()+(hours.weekday-jst.getUTCDay()+7)%7);
  const [hour,minute]=hours.start_time.split(':').map(Number);
  jst.setUTCHours(hour,minute,0,0);
  if(jst.getTime()-9*3600000<=now.getTime())jst.setUTCDate(jst.getUTCDate()+7);
  const start=new Date(jst.getTime()-9*3600000);
  const [endHour,endMinute]=hours.end_time.split(':').map(Number);
  jst.setUTCHours(endHour,endMinute,0,0);
  if(hours.end_time<hours.start_time)jst.setUTCDate(jst.getUTCDate()+1);
  return {starts_at:start.toISOString(),ends_at:new Date(jst.getTime()-9*3600000).toISOString()};
}
