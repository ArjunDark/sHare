
import { useState } from 'react'

type Expense = {
 id:string
 payer:string
 amount:number
 note:string
}

export default function App(){
 const [expenses,setExpenses] = useState<Expense[]>([])
 const [note,setNote]=useState('')
 const [amount,setAmount]=useState('')

 function addExpense(){
  if(!amount) return
  setExpenses([
   ...expenses,
   {
    id:crypto.randomUUID(),
    payer:'me',
    amount:Number(amount),
    note
   }
  ])
  setAmount('')
  setNote('')
 }

 const total = expenses.reduce((a,b)=>a+b.amount,0)

 return (
  <div style={{fontFamily:'sans-serif',padding:24,maxWidth:700}}>
   <h1>shAir</h1>
   <p>Share expenses, not data.</p>

   <div style={{display:'flex',gap:8}}>
    <input placeholder="note" value={note} onChange={e=>setNote(e.target.value)} />
    <input placeholder="amount" value={amount} onChange={e=>setAmount(e.target.value)} />
    <button onClick={addExpense}>Add</button>
   </div>

   <h3>Total ₹{total}</h3>

   {expenses.map(e=>(
    <div key={e.id} style={{border:'1px solid #ccc',padding:12,marginTop:8}}>
      <b>{e.note}</b>
      <div>₹{e.amount}</div>
      <small>{e.payer}</small>
    </div>
   ))}
  </div>
 )
}
