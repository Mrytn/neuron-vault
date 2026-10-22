export class ApiError extends Error {status:number;constructor(message:string,status:number){super(message);this.status=status;}}
export async function api<T>(path:string,init?:RequestInit):Promise<T>{
  let response:Response;
  try{response=await fetch(`/api${path}`,{...init,headers:{...(init?.body?{'Content-Type':'application/json'}:{}),...init?.headers}});}catch{throw new ApiError('无法连接本地服务。请确认 Java 服务已在 127.0.0.1:8787 启动。',0);}
  if(!response.ok){let message=`请求失败（${response.status}）`;try{const data=await response.json();message=data.error||message;}catch{/* response is not JSON */}throw new ApiError(message,response.status);}
  return response.json() as Promise<T>;
}
export const post = <T>(path:string,data:unknown)=>api<T>(path,{method:'POST',body:JSON.stringify(data)});
export const put = <T>(path:string,data:unknown)=>api<T>(path,{method:'PUT',body:JSON.stringify(data)});
