package local.neuronvault;

import org.springframework.http.*;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.web.HttpRequestMethodNotSupportedException;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.servlet.NoHandlerFoundException;
import org.springframework.web.servlet.resource.NoResourceFoundException;
import java.io.IOException;
import java.util.Map;

@RestControllerAdvice
public class ApiErrors {
    @ExceptionHandler(ApiException.class) public ResponseEntity<?> api(ApiException e) { return response(e.status, e.getMessage()); }
    @ExceptionHandler(HttpMessageNotReadableException.class) public ResponseEntity<?> json(Exception e) { return response(400, "请求 JSON 无效或缺少必要字段。"); }
    @ExceptionHandler({NoHandlerFoundException.class, NoResourceFoundException.class}) public ResponseEntity<?> missing(Exception e) { return response(404, "接口不存在。"); }
    @ExceptionHandler(HttpRequestMethodNotSupportedException.class) public ResponseEntity<?> method(Exception e) { return response(405, "不支持此请求方法。"); }
    @ExceptionHandler(IOException.class) public ResponseEntity<?> disk(Exception e) { return response(500, "本地文件操作失败，请检查文件权限、剩余空间和知识库路径。"); }
    @ExceptionHandler(Exception.class) public ResponseEntity<?> unknown(Exception e) { return response(500, "操作失败，请检查输入或稍后重试。"); }
    private ResponseEntity<?> response(int status, String error) { return ResponseEntity.status(status).body(Map.of("error", error)); }
}
