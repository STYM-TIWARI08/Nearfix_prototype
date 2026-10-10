const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const databasePath = path.join(__dirname, '..', 'backend', 'data', 'data.json');
const demoPassword = 'NearFixDemo26!';
const demoAccounts = [
  {id:'demo-customer-user',role:'customer',name:'Demo Customer',email:'demo.customer@nearfix.test',phone:'',area:'Ghaziabad, Uttar Pradesh'},
  {id:'demo-admin-user',role:'admin',name:'Demo Administrator',email:'demo.admin@nearfix.test',phone:'',area:'All Areas'}
];

// These fictional profiles are marked as demos so nobody mistakes them for verified providers.
const demoTechnicians = [
  {number:1,name:'Amit Verma',service:'Electrician',category:'Electrical',area:'Indirapuram, Ghaziabad',exp:7,rating:4.8,reviews:86,distance:2.1,price:349,available:true,response:96,jobs:214,eta:18,skills:['Home wiring','Switches and sockets','MCB repair']},
  {number:2,name:'Ramesh Chauhan',service:'Plumber',category:'Plumbing',area:'Vaishali, Ghaziabad',exp:9,rating:4.7,reviews:112,distance:3.4,price:299,available:true,response:94,jobs:286,eta:22,skills:['Tap repair','Pipe leakage','Bathroom fittings']},
  {number:3,name:'Sandeep Kumar',service:'AC Technician',category:'AC Repair',area:'Sector 62, Noida',exp:8,rating:4.9,reviews:98,distance:6.8,price:499,available:true,response:97,jobs:241,eta:30,skills:['AC servicing','Cooling issues','Installation']},
  {number:4,name:'Prakash Singh',service:'Appliance Technician',category:'Appliance Repair',area:'Crossings Republik, Ghaziabad',exp:6,rating:4.8,reviews:73,distance:4.2,price:399,available:true,response:92,jobs:167,eta:25,skills:['Mixer grinder','Washing machine','Refrigerator']},
  {number:5,name:'Faizan Ali',service:'Carpenter',category:'Carpentry',area:'Vasundhara, Ghaziabad',exp:10,rating:4.9,reviews:134,distance:3.8,price:449,available:true,response:95,jobs:302,eta:24,skills:['Furniture repair','Door fitting','Cabinet work']},
  {number:6,name:'Rajesh Sharma',service:'Painter',category:'Painting',area:'Sector 50, Noida',exp:12,rating:4.6,reviews:65,distance:7.6,price:549,available:false,response:88,jobs:193,eta:40,skills:['Interior painting','Wall preparation','Waterproof coating']},
  {number:7,name:'Meena Kumari',service:'Cleaning Expert',category:'Cleaning',area:'Kaushambi, Ghaziabad',exp:5,rating:4.8,reviews:91,distance:2.7,price:299,available:true,response:98,jobs:228,eta:20,skills:['Deep cleaning','Kitchen cleaning','Bathroom cleaning']},
  {number:8,name:'Karan Singh',service:'Computer Technician',category:'Computer Repair',area:'Sector 63, Noida',exp:7,rating:4.7,reviews:58,distance:7.2,price:399,available:true,response:91,jobs:142,eta:35,skills:['Laptop repair','Wi-Fi setup','Software troubleshooting']},
  {number:9,name:'Akash Gupta',service:'Mobile Technician',category:'Mobile Repair',area:'Raj Nagar, Ghaziabad',exp:4,rating:4.6,reviews:49,distance:5.1,price:299,available:true,response:90,jobs:118,eta:28,skills:['Screen replacement','Charging repair','Phone diagnostics']},
  {number:10,name:'Irfan Khan',service:'Locksmith',category:'Locksmith',area:'Sector 18, Noida',exp:11,rating:4.8,reviews:77,distance:8.4,price:349,available:false,response:89,jobs:205,eta:45,skills:['Door locks','Lock replacement','Emergency opening']},
  {number:11,name:'Mohit Yadav',service:'Vehicle Mechanic',category:'Mechanic',area:'Sector 15, Noida',exp:8,rating:4.7,reviews:83,distance:8.1,price:499,available:true,response:93,jobs:176,eta:38,skills:['Two-wheeler repair','Battery check','Basic servicing']},
  {number:12,name:'Nitin Rawat',service:'Handyman',category:'General Repair',area:'Shipra Suncity, Ghaziabad',exp:6,rating:4.5,reviews:42,distance:3.2,price:299,available:true,response:87,jobs:105,eta:23,skills:['Minor home repairs','Fixture installation','Assembly']}
];

function hashPassword(password){
  const salt=crypto.randomBytes(16).toString('hex');
  const derived=crypto.scryptSync(password,salt,64,{N:16384,r:8,p:1}).toString('hex');
  return `scrypt$16384$8$1$${salt}$${derived}`;
}

const data=JSON.parse(fs.readFileSync(databasePath,'utf8'));
data.users=Array.isArray(data.users)?data.users:[];
data.technicians=Array.isArray(data.technicians)?data.technicians:[];
let added=0;

// Keep dedicated customer and admin demo logins available after a database reset.
for(const account of demoAccounts){
  const existing=data.users.find(item=>item.email.toLowerCase()===account.email);
  if(!existing){
    data.users.push({...account,passwordHash:hashPassword(demoPassword),demoProfile:true});
  }
}

for(const demo of demoTechnicians){
  const suffix=String(demo.number).padStart(2,'0');
  const email=`demo.tech${suffix}@nearfix.test`;
  const userId=`demo-tech-user-${suffix}`;
  let user=data.users.find(item=>item.email===email);
  if(!user){
    user={id:userId,role:'technician',name:demo.name,email,passwordHash:hashPassword(demoPassword),phone:'',area:demo.area,demoProfile:true};
    data.users.push(user);
  }
  let profile=data.technicians.find(item=>String(item.id)===String(7100+demo.number)||item.userId===user.id);
  const values={id:7100+demo.number,userId:user.id,name:demo.name,service:demo.service,category:demo.category,area:demo.area,exp:demo.exp,rating:demo.rating,reviews:demo.reviews,distance:demo.distance,price:demo.price,available:demo.available,response:demo.response,jobs:demo.jobs,eta:demo.eta,completionRate:96,cancellationRate:2,repeatCustomers:18,verified:false,identityVerified:false,skillVerified:false,experienceVerified:false,skills:demo.skills,upiId:`demo.tech${suffix}@nearfix`,demoProfile:true};
  if(profile) Object.assign(profile,values);
  else {data.technicians.push(values);added+=1;}
}

fs.writeFileSync(databasePath,`${JSON.stringify(data,null,2)}\n`);
console.log(`Demo technician profiles ready: ${demoTechnicians.length} total, ${added} newly added.`);
