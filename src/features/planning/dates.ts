export function monthDay(month: string, day: number) {
 const [y,m]=month.slice(0,7).split('-').map(Number);
 const last=new Date(Date.UTC(y,m,0)).getUTCDate();
 return `${y}-${String(m).padStart(2,'0')}-${String(Math.min(day,last)).padStart(2,'0')}`;
}
export function addMonths(date: string, count: number, anchor=Number(date.slice(8,10))) {
 const [y,m]=date.slice(0,7).split('-').map(Number); const d=new Date(Date.UTC(y,m-1+count,1));
 return monthDay(`${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}`,anchor);
}
export function addDays(date: string, count: number) { const d=new Date(`${date}T12:00:00Z`);d.setUTCDate(d.getUTCDate()+count);return d.toISOString().slice(0,10); }
